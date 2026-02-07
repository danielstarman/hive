#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

struct PtySession {
    name: String,
    role: String,
    pty: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send>,
}

#[derive(Default)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

#[derive(Clone, Serialize)]
struct SpawnResult {
    id: String,
    name: String,
    role: String,
}

#[derive(Clone, Serialize)]
struct AgentInfo {
    id: String,
    name: String,
    role: String,
}

#[derive(Clone, Serialize)]
struct PtyOutputEvent {
    id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct AgentExitedEvent {
    id: String,
    code: Option<i32>,
}

fn resolve_project_root() -> PathBuf {
    let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if candidate.exists() {
        return candidate.canonicalize().unwrap_or(candidate);
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn build_pi_command(name: &str, role: &str, id: &str) -> CommandBuilder {
    let root = resolve_project_root();
    let extension = root.join("src").join("index.ts");

    let mut command = CommandBuilder::new("pi");
    if extension.exists() {
        command.arg("-e");
        command.arg(extension.to_string_lossy().to_string());
    }

    command.cwd(root);
    command.env("HIVE_NAME", name);
    command.env("HIVE_ROLE", role);
    command.env("HIVE_ID", id);
    command.env("HIVE_INTERACTIVE", "1");
    command
}

#[tauri::command]
fn spawn_agent(name: String, role: String, app: AppHandle, state: State<AppState>) -> Result<SpawnResult, String> {
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "failed to lock session map".to_string())?;

        if sessions.values().any(|s| s.name == name) {
            return Err(format!("agent name \"{}\" is already running", name));
        }
    }

    let id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to open PTY: {}", err))?;

    let command = build_pi_command(&name, &role, &id);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("failed to spawn pi: {}", err))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("failed to clone PTY reader: {}", err))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("failed to open PTY writer: {}", err))?;

    let sessions_for_thread = Arc::clone(&state.sessions);
    let app_for_thread = app.clone();
    let id_for_thread = id.clone();

    thread::spawn(move || {
        let mut buffer = [0u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app_for_thread.emit(
                        "pty-output",
                        PtyOutputEvent {
                            id: id_for_thread.clone(),
                            data: buffer[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }

        if let Ok(mut sessions) = sessions_for_thread.lock() {
            sessions.remove(&id_for_thread);
        }

        let _ = app_for_thread.emit(
            "agent-exited",
            AgentExitedEvent {
                id: id_for_thread,
                code: None,
            },
        );
    });

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "failed to lock session map".to_string())?;

        sessions.insert(
            id.clone(),
            PtySession {
                name: name.clone(),
                role: role.clone(),
                pty: pair.master,
                writer,
                child,
            },
        );
    }

    Ok(SpawnResult { id, name, role })
}

#[tauri::command]
fn list_agents(state: State<AppState>) -> Result<Vec<AgentInfo>, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "failed to lock session map".to_string())?;

    let agents = sessions
        .iter()
        .map(|(id, session)| AgentInfo {
            id: id.clone(),
            name: session.name.clone(),
            role: session.role.clone(),
        })
        .collect::<Vec<_>>();

    Ok(agents)
}

#[tauri::command]
fn write_pty(id: String, data: String, state: State<AppState>) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "failed to lock session map".to_string())?;

    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("unknown agent id {}", id))?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("write failed: {}", err))?;
    session
        .writer
        .flush()
        .map_err(|err| format!("flush failed: {}", err))?;
    Ok(())
}

#[tauri::command]
fn resize_pty(id: String, cols: u16, rows: u16, state: State<AppState>) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "failed to lock session map".to_string())?;

    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("unknown agent id {}", id))?;

    session
        .pty
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("resize failed: {}", err))?;

    Ok(())
}

#[tauri::command]
fn kill_agent(id: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let maybe_session = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "failed to lock session map".to_string())?;
        sessions.remove(&id)
    };

    let mut session = maybe_session.ok_or_else(|| format!("unknown agent id {}", id))?;
    session
        .child
        .kill()
        .map_err(|err| format!("kill failed: {}", err))?;

    let _ = app.emit(
        "agent-exited",
        AgentExitedEvent {
            id,
            code: None,
        },
    );

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_agent,
            list_agents,
            write_pty,
            resize_pty,
            kill_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running hive desktop");
}

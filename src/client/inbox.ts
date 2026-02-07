/**
 * Hive Inbox — processes incoming messages from the broker.
 *
 * Messages are queued and processed one at a time to avoid
 * interleaving in the agent's conversation. For request/response DMs,
 * the assistant's response is captured and routed back to the sender.
 *
 * Key design:
 * - Messages are always queued, never processed inline
 * - After agent_end, we defer processing to let pi fully settle into idle
 * - Empty responses are handled gracefully with a fallback message
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { HiveClient } from "./connection.js";
import type { BrokerMessage } from "../broker/protocol.js";

interface QueuedMessage {
  /** Label for display: "From scout", "Broadcast from hub", "#backend from worker" */
  label: string;
  /** The message content */
  content: string;
  /** If set, we need to capture the response and send it back */
  replyTo?: {
    agentName: string;
    correlationId: string;
  };
}

/** How long to wait after agent_end before processing the next queued message (ms) */
const IDLE_SETTLE_DELAY = 300;

export class Inbox {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private agentBusy = false;
  private pendingReply: {
    agentName: string;
    correlationId: string;
  } | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private pi: ExtensionAPI,
    private client: HiveClient,
    private selfName: string
  ) {}

  /**
   * Enqueue an incoming broker message for processing.
   */
  handleBrokerMessage(msg: BrokerMessage): void {
    switch (msg.type) {
      case "dm":
        if (msg.correlationId) {
          // Request/response DM — need to capture and return response
          this.enqueue({
            label: `From ${msg.fromName}`,
            content: msg.content,
            replyTo: {
              agentName: msg.fromName,
              correlationId: msg.correlationId,
            },
          });
        } else {
          // Fire-and-forget DM
          this.enqueue({
            label: `From ${msg.fromName}`,
            content: msg.content,
          });
        }
        break;

      case "broadcast":
        this.enqueue({
          label: `Broadcast from ${msg.fromName}`,
          content: msg.content,
        });
        break;

      case "channel_message":
        this.enqueue({
          label: `#${msg.channel} from ${msg.fromName}`,
          content: msg.content,
        });
        break;
    }
  }

  /**
   * Called when the agent starts processing (agent_start event).
   */
  onAgentStart(): void {
    this.agentBusy = true;
    // Cancel any pending settle timer — agent is active again
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  /**
   * Called when the agent finishes processing (agent_end event).
   * If we're waiting for a DM response, capture it here.
   */
  onAgentEnd(messages: any[]): void {
    this.agentBusy = false;

    if (this.pendingReply) {
      // Extract the last assistant text as the response
      const response = this.extractLastAssistantText(messages);
      const trimmed = response.trim();

      // Send dm_response back via the broker
      this.client.send({
        type: "dm_response",
        to: this.pendingReply.agentName,
        correlationId: this.pendingReply.correlationId,
        content: trimmed || "(agent processing — no text response produced)",
      });

      this.pendingReply = null;
      this.processing = false;
    } else if (this.processing) {
      // Was processing a fire-and-forget/broadcast, now done
      this.processing = false;
    }

    // Defer next message processing to let pi fully settle into idle.
    // This prevents injecting a message while pi is still transitioning
    // between turns, which can cause empty or garbled responses.
    this.scheduleProcessNext();
  }

  // ── Internal ──────────────────────────────────────────────────────

  private enqueue(msg: QueuedMessage): void {
    this.queue.push(msg);
    // If agent is idle and we're not already processing, schedule processing
    if (!this.processing && !this.agentBusy) {
      this.scheduleProcessNext();
    }
  }

  /**
   * Schedule processNext with a delay to ensure the agent is truly idle.
   * Cancels any previous scheduled processing.
   */
  private scheduleProcessNext(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.processNext();
    }, IDLE_SETTLE_DELAY);
  }

  private processNext(): void {
    if (this.processing || this.agentBusy || this.queue.length === 0) return;

    this.processing = true;
    const msg = this.queue.shift()!;

    if (msg.replyTo) {
      // Request/response DM: set up reply capture
      this.pendingReply = msg.replyTo;
    }

    // Inject the message into the agent's conversation.
    // This triggers a new turn — the LLM will process and respond.
    const text = `[${msg.label}]: ${msg.content}`;

    try {
      this.pi.sendUserMessage(text);
    } catch {
      // Agent might be streaming despite our checks — deliver as follow-up
      try {
        this.pi.sendUserMessage(text, { deliverAs: "followUp" });
      } catch {
        // Complete failure — clean up and move on
        if (this.pendingReply) {
          this.client.send({
            type: "dm_response",
            to: this.pendingReply.agentName,
            correlationId: this.pendingReply.correlationId,
            content: "(failed to deliver message to agent)",
          });
          this.pendingReply = null;
        }
        this.processing = false;
        this.scheduleProcessNext();
      }
    }
  }

  private extractLastAssistantText(messages: any[]): string {
    // Walk backwards through messages to find the last assistant text
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.content) {
        // Walk content parts backwards too — last text part is most relevant
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const part = msg.content[j];
          if (part.type === "text" && part.text && part.text.trim()) {
            return part.text;
          }
        }
      }
    }
    return "";
  }
}

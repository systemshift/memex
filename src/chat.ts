/**
 * ChatEngine: multi-turn tool loop, auto-ingest, memory.
 */

import { ChatProvider, type StreamEvent, type ToolCallResult } from "./provider";
import { TOOL_DEFS, executeTool, ingestConversationTurn, loadRecentConversations } from "./tools";
import { getSystemPrompt } from "./prompts";

export type OnText = (text: string) => void;
export type OnTool = (toolName: string) => void;

export class ChatEngine {
  private provider: ChatProvider;
  private messages: Array<Record<string, any>> = [];
  private firstRun: boolean;
  private toolNamesThisTurn: string[] = [];
  private memoryLoaded = false;

  constructor(firstRun = false) {
    this.provider = new ChatProvider();
    this.firstRun = firstRun;
  }

  async loadMemory(): Promise<void> {
    if (this.memoryLoaded || this.firstRun) return;
    const prior = await loadRecentConversations(20);
    if (prior.length) {
      this.messages.unshift(...prior);
    }
    this.memoryLoaded = true;
  }

  async send(
    userInput: string,
    onText: OnText,
    onTool: OnTool,
  ): Promise<void> {
    this.messages.push({ role: "user", content: userInput });
    this.toolNamesThisTurn = [];

    const systemPrompt = getSystemPrompt(this.firstRun);

    let prevId: string | null = null;
    let pendingToolOutputs: any[] = [];

    const maxTurns = 10;
    for (let i = 0; i < maxTurns; i++) {
      let textBuffer = "";
      const toolCalls: ToolCallResult[] = [];

      const inputMsgs = prevId === null ? this.messages : pendingToolOutputs;

      for await (const event of this.provider.stream(
        systemPrompt,
        inputMsgs,
        TOOL_DEFS,
        prevId,
      )) {
        if (event.type === "text" && event.text) {
          onText(event.text);
          textBuffer += event.text;
        } else if (event.type === "tool_call" && event.toolCall) {
          toolCalls.push(event.toolCall);
          this.toolNamesThisTurn.push(event.toolCall.name);
          onTool(`[${event.toolCall.name}]`);
        } else if (event.type === "error") {
          onText(`\nError: ${event.error}`);
          return;
        }
      }

      // If there were tool calls, execute and send results back
      if (toolCalls.length) {
        prevId = this.provider.lastResponseId;
        pendingToolOutputs = [];

        for (const tc of toolCalls) {
          const result = await executeTool(tc.name, tc.arguments);
          pendingToolOutputs.push({
            type: "function_call_output",
            call_id: tc.callId,
            output: result,
          });
        }
        continue;
      }

      // No tool calls — turn complete
      if (textBuffer) {
        this.messages.push({ role: "assistant", content: textBuffer });
        // Auto-ingest in background — don't await
        ingestConversationTurn(
          userInput,
          textBuffer,
          this.toolNamesThisTurn.length ? this.toolNamesThisTurn : undefined,
        ).catch(() => {});
      }
      return;
    }
  }

  clear(): void {
    this.messages = [];
  }
}

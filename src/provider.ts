/**
 * OpenAI Responses API streaming provider.
 */

import OpenAI from "openai";

export interface ToolCallResult {
  callId: string;
  name: string;
  arguments: Record<string, any>;
}

export interface StreamEvent {
  type: "text" | "tool_call" | "done" | "error";
  text?: string;
  toolCall?: ToolCallResult;
  error?: string;
}

export class ChatProvider {
  private client: OpenAI | null = null;
  readonly model: string;
  private _lastResponseId: string | null = null;

  constructor(model?: string) {
    this.model = model ?? process.env.OPENAI_MODEL ?? "gpt-5.2";
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI();
    }
    return this.client;
  }

  get lastResponseId(): string | null {
    return this._lastResponseId;
  }

  async *stream(
    system: string,
    messages: Array<Record<string, any>>,
    tools?: any[],
    previousResponseId?: string | null,
  ): AsyncGenerator<StreamEvent> {
    try {
      const kwargs: Record<string, any> = {
        model: this.model,
        instructions: system,
        input: messages,
        stream: true,
      };
      if (tools?.length) {
        kwargs.tools = tools;
      }
      if (previousResponseId) {
        kwargs.previous_response_id = previousResponseId;
      }

      const stream = await (this.getClient().responses as any).create(kwargs);

      for await (const event of stream as AsyncIterable<any>) {
        if (event.type === "response.output_text.delta") {
          yield { type: "text", text: event.delta };
        } else if (event.type === "response.output_item.done") {
          const item = event.item;
          if (item?.type === "function_call") {
            let args: Record<string, any> = {};
            try {
              args = item.arguments ? JSON.parse(item.arguments) : {};
            } catch {}
            yield {
              type: "tool_call",
              toolCall: {
                callId: item.call_id,
                name: item.name,
                arguments: args,
              },
            };
          }
        } else if (event.type === "response.completed") {
          this._lastResponseId = event.response?.id ?? null;
          yield { type: "done" };
        } else if (event.type === "response.failed") {
          yield { type: "error", error: "Response failed" };
        }
      }
    } catch (e: any) {
      yield { type: "error", error: e.message };
    }
  }
}

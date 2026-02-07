"""Chat provider for Memex using OpenAI Responses API."""

import os
import json
from typing import AsyncGenerator
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass
class ToolCall:
    """A tool call request from the model."""

    call_id: str
    name: str
    arguments: dict


@dataclass
class Chunk:
    """Stream chunk from model."""

    type: str  # "text" | "tool_call" | "done" | "error"
    text: str = ""
    tool_call: ToolCall | None = None
    error: str = ""


class ChatProvider:
    """OpenAI Responses API provider with async streaming and tool support."""

    def __init__(self, model: str | None = None):
        self._client = None
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-5.2")

    @property
    def client(self):
        """Lazy-initialize async OpenAI client."""
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI()
        return self._client

    def _convert_tools(self, tools: list[dict]) -> list[dict]:
        """Convert chat-completions tool format to Responses API format.

        Chat completions: {"type": "function", "function": {"name": ..., "parameters": ...}}
        Responses API:    {"type": "function", "name": ..., "parameters": ...}
        """
        converted = []
        for tool in tools:
            if tool.get("type") == "function" and "function" in tool:
                fn = tool["function"]
                converted.append({
                    "type": "function",
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters", {}),
                    "strict": False,
                })
            else:
                converted.append(tool)
        return converted

    async def stream(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        previous_response_id: str | None = None,
    ) -> AsyncGenerator[Chunk, None]:
        """Stream a response using the Responses API.

        Args:
            system: System instructions
            messages: Conversation messages (used as input)
            tools: Tool definitions
            previous_response_id: Chain to a previous response

        Yields:
            Chunk objects with text, tool_calls, or errors
        """
        from openai.types.responses import (
            ResponseTextDeltaEvent,
            ResponseOutputItemDoneEvent,
            ResponseCompletedEvent,
            ResponseFailedEvent,
            ResponseFunctionToolCall,
        )

        try:
            kwargs = {
                "model": self.model,
                "instructions": system,
                "input": messages,
                "stream": True,
            }
            if tools:
                kwargs["tools"] = self._convert_tools(tools)
            if previous_response_id:
                kwargs["previous_response_id"] = previous_response_id

            stream = await self.client.responses.create(**kwargs)

            async for event in stream:
                if isinstance(event, ResponseTextDeltaEvent):
                    yield Chunk(type="text", text=event.delta)

                elif isinstance(event, ResponseOutputItemDoneEvent):
                    item = event.item
                    if isinstance(item, ResponseFunctionToolCall):
                        try:
                            args = json.loads(item.arguments) if item.arguments else {}
                        except json.JSONDecodeError:
                            args = {}
                        yield Chunk(
                            type="tool_call",
                            tool_call=ToolCall(
                                call_id=item.call_id,
                                name=item.name,
                                arguments=args,
                            ),
                        )

                elif isinstance(event, ResponseCompletedEvent):
                    self._last_response_id = event.response.id
                    yield Chunk(type="done")

                elif isinstance(event, ResponseFailedEvent):
                    yield Chunk(type="error", error="Response failed")

        except Exception as e:
            yield Chunk(type="error", error=str(e))

    @property
    def last_response_id(self) -> str | None:
        """Get the last response ID for chaining tool results."""
        return getattr(self, "_last_response_id", None)

"""Memex Application."""

from textual.app import App, ComposeResult
from textual.widgets import Input
from textual.binding import Binding

from .chat import ChatPanel, ChatEngine


class MemexApp(App):
    """Interactive interface for memex-server and dagit."""

    CSS = """
    #chat-log {
        height: 1fr;
        border: solid $primary;
        padding: 1;
    }

    #input {
        dock: bottom;
        margin: 1 1 0 1;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit"),
        Binding("ctrl+l", "clear", "Clear"),
        Binding("escape", "focus_input", "Focus Input", show=False),
    ]

    TITLE = "Memex"

    def __init__(self, first_run: bool = False):
        super().__init__()
        self.first_run = first_run
        self.chat_engine = ChatEngine(first_run=first_run)
        self._current_response = ""
        self._streaming = False

    def compose(self) -> ComposeResult:
        """Create the UI layout."""
        yield ChatPanel(id="chat-log")
        yield Input(placeholder="Ask anything... (Ctrl+C to quit)", id="input")

    def on_mount(self) -> None:
        """Focus input on start."""
        self.query_one("#input", Input).focus()
        chat = self.query_one("#chat-log", ChatPanel)

        if self.first_run:
            chat.add_system_message("Welcome to Memex — setting things up...")
            self.run_worker(self._auto_greet())
        else:
            chat.add_system_message(
                "Welcome to Memex. Ask questions about your knowledge graph or dagit network."
            )
            chat.add_system_message('Type "help" for commands, Ctrl+C to quit.')
            # Load session memory in background
            self.run_worker(self.chat_engine.load_memory())

    async def _auto_greet(self) -> None:
        """Send initial greeting on first run so the LLM speaks first."""
        chat = self.query_one("#chat-log", ChatPanel)
        self._current_response = ""

        async def on_text(text: str) -> None:
            self._current_response += text

        async def on_tool(tool_name: str) -> None:
            chat.add_tool_indicator(tool_name)

        try:
            await self.chat_engine.send(
                "I just installed memex. Help me get started.", on_text, on_tool
            )
        except Exception as e:
            chat.add_error(str(e))

        if self._current_response:
            chat.add_assistant_response(self._current_response)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle user input."""
        user_input = event.value.strip()
        if not user_input:
            return

        # Ignore if already streaming
        if self._streaming:
            return

        # Clear input
        input_widget = self.query_one("#input", Input)
        input_widget.value = ""

        chat = self.query_one("#chat-log", ChatPanel)

        # Handle special commands
        if user_input.lower() in ("exit", "quit"):
            self.exit()
            return

        if user_input.lower() == "clear":
            self.action_clear()
            return

        if user_input.lower() == "help":
            self._show_help(chat)
            return

        # Show user message and launch streaming in a worker
        chat.add_user_message(user_input)
        self.run_worker(self._stream_response(user_input))

    async def _stream_response(self, user_input: str) -> None:
        """Stream LLM response as a background worker so input stays responsive."""
        self._streaming = True
        chat = self.query_one("#chat-log", ChatPanel)
        self._current_response = ""

        async def on_text(text: str) -> None:
            self._current_response += text

        async def on_tool(tool_name: str) -> None:
            chat.add_tool_indicator(tool_name)

        try:
            await self.chat_engine.send(user_input, on_text, on_tool)
        except Exception as e:
            chat.add_error(str(e))

        if self._current_response:
            chat.add_assistant_response(self._current_response)

        self._streaming = False

    def _show_help(self, chat: ChatPanel) -> None:
        """Show help message."""
        chat.add_system_message("Commands:")
        chat.add_system_message("  help  - Show this help")
        chat.add_system_message("  clear - Clear chat history")
        chat.add_system_message("  exit  - Quit the application")
        chat.add_system_message("")
        chat.add_system_message("Examples:")
        chat.add_system_message('  "search for notes about topic"')
        chat.add_system_message('  "what\'s my dagit identity"')
        chat.add_system_message('  "save this as a note: <your content>"')
        chat.add_system_message('  "post to dagit: <your message>"')

    def action_clear(self) -> None:
        """Clear chat history."""
        self.chat_engine.clear()
        chat = self.query_one("#chat-log", ChatPanel)
        chat.clear()
        chat.add_system_message("Chat cleared.")

    def action_focus_input(self) -> None:
        """Focus the input field."""
        self.query_one("#input", Input).focus()

    def action_quit(self) -> None:
        """Quit the application."""
        self.exit()

"""First-run onboarding prompt for new users."""

from .chat import SYSTEM_PROMPT

ONBOARDING_ADDENDUM = """

This is the user's first session. Follow these steps:

1. Call `dagit_whoami` to get their decentralized identity.
2. Welcome them. Show their DID. Explain: memex is their personal knowledge graph — everything they type here is automatically remembered. Dagit is their public identity on a decentralized network.
3. Ask what they'd like to save first — a thought, a note, anything.
4. Save it with `memex_create_node`. Create links to any entities mentioned.
5. Suggest they introduce themselves to the network with `dagit_post`.

Keep it short. They're here to work."""


def get_system_prompt(first_run: bool) -> str:
    """Return system prompt, with onboarding addendum if first run."""
    if first_run:
        return SYSTEM_PROMPT + ONBOARDING_ADDENDUM
    return SYSTEM_PROMPT

"""Plain-text validation for user-provided names and place labels."""
from unicodedata import category


def validate_plain_text(value: str) -> str:
    """Reject markup delimiters and Unicode control characters without changing text.

    Raises:
        ValueError: If the input contains angle brackets or control characters.
    """
    if any(char in '<>' or category(char) == 'Cc' for char in value):
        raise ValueError('Markup and control characters are not allowed')
    return value

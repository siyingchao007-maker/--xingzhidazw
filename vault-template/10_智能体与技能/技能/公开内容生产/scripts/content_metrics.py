#!/usr/bin/env python3
"""Local text counts, not platform limits or a semantic quality score."""
import argparse
import json
import re
from pathlib import Path


def is_han(char):
    point = ord(char)
    return any(start <= point <= end for start, end in (
        (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
        (0x20000, 0x2EE5F), (0x2F800, 0x2FA1F), (0x30000, 0x323AF),
    ))


def measure(text):
    return {
        "han_characters": sum(is_han(char) for char in text),
        "non_whitespace_codepoints": sum(not char.isspace() for char in text),
        "nonempty_lines": sum(bool(line.strip()) for line in text.splitlines()),
        "paragraphs_by_blank_line": sum(
            bool(part.strip()) for part in re.split(r"\n\s*\n", text)
        ),
        "count_scope": "entire_input_including_markdown_links_and_metadata",
        "platform_limit_verified": False,
        "semantic_quality_assessed": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="UTF-8 text or Markdown file")
    args = parser.parse_args()
    try:
        result = measure(args.file.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError) as error:
        parser.exit(2, f"Cannot read input: {error}\n")
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()

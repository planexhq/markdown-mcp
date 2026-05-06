---
title: Nested frontmatter test
tags:
  - api
  - auth
book:
  author:
    name: Jane Doe
    email: jane@example.com
  isbn: "978-0-13-110362-7"
status: draft
created: 2026-05-06
updated: 2026-05-06T12:30:00Z
---

# Body heading

Frontmatter test fixture. `metadata.book.author.name` should resolve to
"Jane Doe" and round-trip through JSON without flattening.

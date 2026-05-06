---
title: Authentication
tags:
  - api
  - api/oauth
  - security
created: 2025-01-15
updated: 2026-04-30
---

# Authentication

Top-level overview of authentication.

## OAuth2

OAuth2 is the primary auth flow. See [[notes/oauth#flows]] for details.

```js
// example code block — should not be parsed as headings
function authenticate(token) {
  return token.length > 0;
}
// ## not a heading
```

## SAML

SAML is supported for enterprise customers. ^saml-block

### SP-initiated flow

Service-provider-initiated flow.

### IdP-initiated flow

Identity-provider-initiated flow.

"""Static bearer-token verification (ADR 0004).

Phase-0 has exactly one principal: the deploy-time token in env and the
user name it belongs to. The compare is constant-time; a mismatch returns
None, which FastMCP's bearer middleware answers with HTTP 401 before any
tool runs — an unauthenticated call never reaches the audit trail either,
because it is not a tool call.
"""

from __future__ import annotations

import hmac

from fastmcp.server.auth import AccessToken, TokenVerifier


class StaticBearerToken(TokenVerifier):
	"""Accepts the one deploy-time token, attributed to its named user."""

	def __init__(self, token: str, user: str) -> None:
		super().__init__()
		self._token = token
		self._user = user

	async def verify_token(self, token: str) -> AccessToken | None:
		if hmac.compare_digest(token, self._token):
			return AccessToken(token=token, client_id=self._user, scopes=[])
		return None

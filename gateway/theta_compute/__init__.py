"""theta-compute — the Theta compute gateway (M4, ADR 0004).

A FastMCP server on the cluster's login node wrapping the Slurm CLI with
argv arrays only. Institutional facts ride deploy-time env (see config);
enforcement — bearer auth, the argument guard, and one audit JSONL line
per tool call — stays server-side. Deploy and audit semantics:
gateway/README.md.
"""

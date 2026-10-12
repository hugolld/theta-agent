---
name: theta-lit-probe
description: PubMed literature search for biomedicine. Runs a PubMed query through NCBI E-utilities (esearch + esummary) and returns structured metadata per paper (title, first author, year, journal, PMID, and DOI). Paces requests to the E-utilities limit (3 per second anonymous, 10 with NCBI_API_KEY), detects API errors that arrive inside HTTP 200 bodies, and redacts api_key, email, and tool values from any echoed request URL. Use for searches of biomedical literature by topic or query; not for full text, citation graphs, or non-biomedical databases.
allowed-tools: Read Bash
license: MIT
metadata:
  version: "0.1.0"
  authorship: self-authored
---

# Theta literature probe

Search PubMed and return structured metadata. Run the bundled script instead of
hand-rolled curl: it enforces E-utilities pacing, detects API errors that
arrive inside HTTP 200 bodies, and redacts credentials from the URLs it echoes.

## Use

	python3 scripts/pubmed_search.py --query "<PubMed query>" [--retmax N] [--sort pub_date] [--json]

- Default output is one line per paper: title | first author | year | journal | PMID | DOI.
- `--retmax` caps results (default 8, max 200). `--sort` accepts relevance (default), pub_date (recent first), Author, JournalName.
- `--json` prints the raw structured records.
- `NCBI_API_KEY` is read from the environment when set; anonymous access runs at 3 requests per second.
- Exit 0 on success. Exit 1 with a message on stderr for usage or API errors, including errors inside HTTP 200 bodies.

Provenance: endpoint contracts per docs/research/2026-10-11-m2-literature-api-contracts.md (NCBI Bookshelf NBK25497/NBK25499, live-probed 2026-10-11).

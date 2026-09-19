# Domain docs

This is a single-context repository. Before exploring or planning work, read:

- `docs/DOMAIN_MODEL.md`, the canonical project glossary and domain model;
- `CONTEXT.md`, if it exists; and
- relevant ADRs under `docs/adr/`, if that directory exists.

If an optional file or directory does not exist, proceed silently. Domain-modeling flows create them lazily when new terms or durable decisions are resolved.

## Use canonical vocabulary

When output names a domain concept—in issue titles, implementation plans, tests, or code—use the term defined in `docs/DOMAIN_MODEL.md`. Do not drift to synonyms that the glossary explicitly avoids.

If a needed concept is absent, reconsider whether it belongs to the project vocabulary or record the gap for domain modeling.

## Flag ADR conflicts

Surface any conflict with an existing ADR explicitly instead of silently overriding it.

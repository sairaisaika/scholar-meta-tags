# Working in SMT

The shared engineering wiki lives in SMV: [engineering entry](../scholar-meta-visulization/docs/wiki/Engineering-entry.md) ·
online https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Engineering-entry.md. Start from the route
`community-annotation` ([Tagging-model](../scholar-meta-visulization/docs/wiki/Tagging-model.md), [Community-annotation](../scholar-meta-visulization/docs/wiki/Community-annotation.md)).
Project status for both repositories, including this one, is kept in the same wiki:
[Project-status](../scholar-meta-visulization/docs/wiki/Project-status.md) · [TODO](../scholar-meta-visulization/docs/wiki/TODO.md)
(online: https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Project-status.md). There is no separate wiki here; update those pages when SMT changes.

Boundaries:

- Rules and shapes come from the `scholar-meta` package (pinned release tarball in `package.json`). Do not re-implement normalisation, quorum rules, intake validation or export shapes here — call the engine. If the engine lacks something, change the engine first.
- This repository stores data (`data/`, `vocab/`, `config/`), runs Actions (`scripts/`) and serves a static page (`site/`). It has no server process and no API for hosts; hosts consume the published export through the engine.
- Never store abstracts, quoted passages, emails or anything beyond `gh:<numeric id>` + login snapshot. Keep derived exports out of `main` (Pages artifact + Release assets).
- Never commit names, domains or internal details of any site that integrates the engine. Run `pnpm check` before committing.

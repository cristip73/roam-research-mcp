# MCP Manifest

When a language model connects to this server it receives a manifest describing available resources. The manifest lists every tool name, a short description and the schema for its parameters. Tools correspond to the operations documented in `Functionality.md`.

Each entry in the manifest looks roughly like:

```json
{
  "name": "tool_name",
  "description": "What the tool does",
  "parameters": { /* JSON Schema */ }
}
```

The manifest presented by this server includes the following tools:

- `roam_add_todo`
- `roam_fetch_page_by_title`
- `roam_create_page`
- `roam_create_block`
- `roam_create_outline`
- `roam_import_markdown`
- `roam_search_for_tag`
- `roam_search_by_status`
- `roam_search_block_refs`
- `roam_search_hierarchy`
- `roam_search_hierarchy_indented`
- `roam_find_pages_modified_today`
- `roam_search_by_text`
- `roam_update_block`
- `roam_update_multiple_blocks`
- `roam_search_by_date`
- `roam_remember`
- `roam_recall`
- `roam_datomic_query`

A client can inspect this manifest to know what operations are supported and how to structure a request. The server uses standard MCP transport so responses are JSON objects containing a success flag, a message and any matches or created UIDs.

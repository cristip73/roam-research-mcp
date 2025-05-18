# MCP Functionality

This repository exposes a Model Context Protocol (MCP) server for Roam Research. Below is a short description of every tool available in the server. Each entry lists the main intent, how it can be invoked conceptually and the type of data an LLM is likely to receive in response.

## Tools

### roam_add_todo
**Intent**: Quickly append todo items to today's daily note so they appear as checkbox blocks.
**How to call**: Request the tool with a list of todo strings ("Buy milk", "Send email").
**Returns**: Success flag and UIDs of created blocks which the LLM can read to confirm tasks were added.

### roam_fetch_page_by_title
**Intent**: Retrieve the full contents of a page including nested blocks and resolved references.
**How to call**: Ask for a page by its title, e.g. "Fetch page 'Project Ideas'".
**Returns**: Markdown text of the page ready to present to the user or further analyse.

### roam_create_page
**Intent**: Make a new page with optional initial outline.
**How to call**: Specify the title and, optionally, an array of items with nesting levels.
**Returns**: Success flag and UID of the created page so it can be linked later.

### roam_create_block
**Intent**: Insert a block on an existing page or on today's page.
**How to call**: Provide the block content and optionally a page title or UID.
**Returns**: Confirmation with the new block UID and the parent page UID.

### roam_create_outline
**Intent**: Add a structured outline beneath a page or block.
**How to call**: Supply an array of text items each with a level number indicating indentation.
**Returns**: Success flag plus list of created block UIDs for the outline.

### roam_import_markdown
**Intent**: Import nested Markdown (bullet list style) under a specific block.
**How to call**: Provide the Markdown text and where it should be inserted (parent block by UID or exact text).
**Returns**: Details about the new blocks including the parent UID and created UIDs.

### roam_search_for_tag
**Intent**: Locate blocks tagged with a particular tag, optionally within a page or near another tag.
**How to call**: Mention the tag text (without brackets) and optional page or nearby tag filters.
**Returns**: Array of matches containing block UIDs and text snippets that include the tag.

### roam_search_by_status
**Intent**: Find blocks marked TODO or DONE.
**How to call**: Indicate the desired status and optional filters or page scope.
**Returns**: Matches with block UIDs, content and the containing page title.

### roam_search_block_refs
**Intent**: Discover where a block is referenced elsewhere or list all references on a page.
**How to call**: Provide the block UID to search for or limit search by page.
**Returns**: Blocks referencing the target UID with their content and location information.

### roam_search_hierarchy
**Intent**: Explore parent‑child relationships between blocks.
**How to call**: Specify either a parent UID (to fetch descendants) or a child UID (to trace ancestors). Optional page and depth parameters refine the search.
**Returns**: An array of blocks each annotated with its depth and page title when relevant.

### roam_search_hierarchy_indented
**Intent**: Produce a human‑readable indented list showing the hierarchy for a given block or its ancestors.
**How to call**: Similar to `roam_search_hierarchy` but requests the indented output. Long results can be paged by specifying `part`.
**Returns**: A single match containing the indented text. When split, it also includes part numbers so the LLM can ask for further parts.

### roam_find_pages_modified_today
**Intent**: List pages that have been edited since midnight today.
**How to call**: Optionally set a maximum number of pages to return.
**Returns**: Array of page titles representing recently edited content.

### roam_search_by_text
**Intent**: Search for blocks containing a specific phrase.
**How to call**: Provide the search text and optionally restrict to a page.
**Returns**: Matches with block UIDs, their content and page titles.

### roam_update_block
**Intent**: Replace or transform the text of a single block.
**How to call**: Give the target block UID and either the new content or a find/replace pattern.
**Returns**: Success status and the final block content after modification.

### roam_update_multiple_blocks
**Intent**: Batch update many blocks in a single operation.
**How to call**: Supply an array of updates, each with a block UID and either new text or a transform pattern.
**Returns**: Per‑block results indicating success or error for each update.

### roam_search_by_date
**Intent**: Retrieve blocks or pages created or modified within a date range.
**How to call**: Provide start and end dates plus flags indicating whether to consider creation dates, modification dates or both.
**Returns**: Matches describing each page or block along with its timestamp.

### roam_remember
**Intent**: Store a memory snippet on the daily page using a special tag.
**How to call**: Pass the text to remember and optional category tags.
**Returns**: Simple success confirmation once the block is created.

### roam_recall
**Intent**: Retrieve previously remembered memories, optionally sorted or filtered by tag.
**How to call**: Request recall with sort order and/or a filter tag.
**Returns**: Array of memory strings with the memories tag removed for easy reading.

### roam_datomic_query
**Intent**: Run a custom Datalog query directly against the Roam graph for advanced cases.
**How to call**: Submit the query string and optional inputs.
**Returns**: The raw query result array formatted as JSON for inspection.


import type { Graph } from '@roam-research/roam-api-sdk';
import { q, createPage as createRoamPage, batchActions, createBlock, updatePage as updateRoamPage } from '../../utils/roam-api-wrapper.js';
import { createToolLimiter } from '../../utils/rate-limiter.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { capitalizeWords } from '../helpers/text.js';
import { resolveRefs } from '../helpers/refs.js';
import type { RoamBlock } from '../types/index.js';
import { 
  parseMarkdown, 
  convertToRoamActions,
  convertToRoamMarkdown,
  hasMarkdownTable 
} from '../../markdown-utils.js';

// Retry configuration
const PAGE_MAX_RETRIES = 8;
const INITIAL_RETRY_DELAY = 2000;

export class PageOperations {
  private limiter = createToolLimiter();
  constructor(private graph: Graph) {}

  async findPagesModifiedToday(max_num_pages: number = 50) {
    // Define ancestor rule for traversing block hierarchy
    const ancestorRule = `[
      [ (ancestor ?b ?a)
        [?a :block/children ?b] ]
      [ (ancestor ?b ?a)
        [?parent :block/children ?b]
        (ancestor ?parent ?a) ]
    ]`;

    // Get start of today
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    try {
      // Query for pages modified today
      const results = await q(
        this.graph,
        `[:find ?title
          :in $ ?start_of_day %
          :where
          [?page :node/title ?title]
          (ancestor ?block ?page)
          [?block :edit/time ?time]
          [(> ?time ?start_of_day)]]
          :limit ${max_num_pages}`,
        [startOfDay.getTime(), ancestorRule]
      ) as [string][];

      if (!results || results.length === 0) {
        return {
          success: true,
          pages: [],
          message: 'No pages have been modified today'
        };
      }

      // Extract unique page titles
      const uniquePages = [...new Set(results.map(([title]) => title))];

      return {
        success: true,
        pages: uniquePages,
        message: `Found ${uniquePages.length} page(s) modified today`
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to find modified pages: ${error.message}`
      );
    }
  }

  /**
   * Helper function to retry operations with exponential backoff
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = PAGE_MAX_RETRIES,
    initialDelay: number = INITIAL_RETRY_DELAY
  ): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const isRateLimitError = 
          error instanceof Error && 
          (error.message.includes('Too many requests') || 
           error.message.includes('rate limit'));
        
        if (!isRateLimitError) {
          throw error; // Not a rate limit error, don't retry
        }
        
        // Calculate delay with exponential backoff
        const delay = initialDelay * Math.pow(2, attempt);
        console.warn(`Rate limit hit in PageOperations, retrying after ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError || new Error('Failed after maximum retry attempts');
  }

  async createPage(title: string, content?: Array<{text: string; level: number}>): Promise<{ success: boolean; uid: string }> {
    return this.retryWithBackoff(async () => {
      // Ensure title is properly formatted
      const pageTitle = String(title).trim();
      
      // First try to find if the page exists
      const findQuery = `[:find ?uid :in $ ?title :where [?e :node/title ?title] [?e :block/uid ?uid]]`;
      type FindResult = [string];
      const findResults = await q(this.graph, findQuery, [pageTitle], this.limiter) as FindResult[];
      
      let pageUid: string | undefined;
      
      if (findResults && findResults.length > 0) {
        // Page exists, use its UID
        pageUid = findResults[0][0];
      } else {
        // Create new page
        try {
          await createRoamPage(this.graph, {
            action: 'create-page',
            page: {
              title: pageTitle
            }
          }, this.limiter);

          // Get the new page's UID
          const results = await q(this.graph, findQuery, [pageTitle], this.limiter) as FindResult[];
          if (!results || results.length === 0) {
            throw new Error('Could not find created page');
          }
          pageUid = results[0][0];
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to create page: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      
      // If content is provided, create blocks with explicit levels
      if (content && content.length > 0) {
        try {
          // Use batch actions to create all blocks at once
          const batchLimit = 10; // Process blocks in smaller batches to avoid overloading
          const levelParents: { [level: number]: string } = {};
          
          // Process blocks in batches
          for (let i = 0; i < content.length; i += batchLimit) {
            const batchBlocks = content.slice(i, i + batchLimit);
            const actions: any[] = [];
            
            for (const block of batchBlocks) {
              const parentUid = block.level === 1 ? pageUid : levelParents[block.level - 1];
              
              if (block.level > 1 && !parentUid) {
                throw new Error(`Invalid block hierarchy: level ${block.level} block has no parent`);
              }
              
              // Generate unique temporary uid for this block
              const tmpUid = `tmp-${Math.random().toString(36).substring(2, 10)}`;
              
              actions.push({
                action: 'create-block',
                location: {
                  'parent-uid': parentUid,
                  order: 'last'
                },
                block: { 
                  string: block.text,
                  uid: tmpUid
                }
              });
              
              // Save temporary UID for hierarchical structuring
              levelParents[block.level] = tmpUid;
            }
            
            // Execute batch action
            if (actions.length > 0) {
              const batchResult = await batchActions(this.graph, {
                action: 'batch-actions',
                actions: actions as any
              }, this.limiter);
              
              if (!batchResult) {
                throw new Error('Failed to create batch of blocks');
              }
            }
            
            // If we have more batches to process, add a small delay
            if (i + batchLimit < content.length) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to add content to page: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      
      return { success: true, uid: pageUid };
    });
  }

  async renamePage(
    page_title_uid: string,
    new_title: string,
    allow_merge: boolean = false,
    children_view_type?: string
  ): Promise<{ success: boolean; page_uid: string; old_title: string; new_title: string; merged?: boolean }> {
    if (!page_title_uid || !new_title) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'page_title_uid and new_title are required'
      );
    }

    const targetTitle = String(new_title).trim();
    if (targetTitle.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, 'new_title cannot be empty');
    }

    return this.retryWithBackoff(async () => {
      // Resolve UID (supports either title or UID input)
      const uidQuery = `[:find ?uid . :in $ ?title :where [?e :node/title ?title] [?e :block/uid ?uid]]`;
      let pageUidRaw = await q(this.graph, uidQuery, [page_title_uid], this.limiter);
      let pageUid: string | null = (pageUidRaw === null || pageUidRaw === undefined) ? null : String(pageUidRaw);
      if (!pageUid) {
        // try direct UID
        const directUidQuery = `[:find ?uid . :where [?e :block/uid "${page_title_uid}"] [?e :block/uid ?uid]]`;
        const d = await q(this.graph, directUidQuery, [], this.limiter);
        pageUid = (d === null || d === undefined) ? null : String(d);
      }

      if (!pageUid) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Page with title/UID "${page_title_uid}" not found`
        );
      }

      // Get old title
      const titleQuery = `[:find ?title . :in $ ?uid :where [?e :block/uid ?uid] [?e :node/title ?title]]`;
      const oldTitleRaw = await q(this.graph, titleQuery, [pageUid], this.limiter);
      const oldTitle: string | null = (oldTitleRaw === null || oldTitleRaw === undefined) ? null : String(oldTitleRaw);
      if (!oldTitle) {
        throw new McpError(ErrorCode.InternalError, `Could not resolve current title for UID ${pageUid}`);
      }
      if (oldTitle === targetTitle) {
        return { success: true, page_uid: pageUid, old_title: oldTitle, new_title: targetTitle };
      }

      // Check if a page with the new title already exists
      const existingRaw = await q(this.graph, uidQuery, [targetTitle], this.limiter);
      const existingUid: string | null = (existingRaw === null || existingRaw === undefined) ? null : String(existingRaw);
      if (existingUid && !allow_merge) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `A page titled "${targetTitle}" already exists. Set allow_merge=true to proceed.`
        );
      }

      // Perform rename via update-page
      await updateRoamPage(this.graph, {
        action: 'update-page',
        page: {
          uid: pageUid,
          title: targetTitle,
          ...(children_view_type ? { 'children-view-type': children_view_type } : {})
        }
      }, this.limiter);

      return {
        success: true,
        page_uid: pageUid,
        old_title: oldTitle,
        new_title: targetTitle,
        ...(existingUid ? { merged: true } : {})
      };
    });
  }

  async renamePages(
    renames: Array<{ page_title_uid: string; new_title: string; allow_merge?: boolean; children_view_type?: string }>
  ): Promise<{
    success: boolean;
    results: Array<{ page_title_uid: string; page_uid?: string; old_title?: string; new_title: string; merged?: boolean; success: boolean; error?: string }>;
  }> {
    if (!Array.isArray(renames) || renames.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, 'renames must be a non-empty array');
    }

    // Pre-validate and resolve UIDs and titles
    type PreItem = {
      input: { page_title_uid: string; new_title: string; allow_merge?: boolean; children_view_type?: string };
      pageUid?: string;
      oldTitle?: string;
      canProceed: boolean;
      reason?: string;
      merged?: boolean;
    };

    const uidByTitle = new Map<string, string>();
    const actions: any[] = [];
    const results: Array<{ page_title_uid: string; page_uid?: string; old_title?: string; new_title: string; merged?: boolean; success: boolean; error?: string }> = [];

    // Helper to find UID by title (cache)
    const findUidByTitle = async (title: string) => {
      if (uidByTitle.has(title)) return uidByTitle.get(title)!;
      const uRaw = await q(this.graph, `[:find ?uid . :in $ ?title :where [?e :node/title ?title] [?e :block/uid ?uid]]`, [title], this.limiter);
      const u = (uRaw === null || uRaw === undefined) ? null : String(uRaw);
      if (u) uidByTitle.set(title, u);
      return u;
    };

    for (const item of renames) {
      const pageKey = String(item.page_title_uid).trim();
      const targetTitle = String(item.new_title).trim();
      if (!pageKey || !targetTitle) {
        results.push({ page_title_uid: item.page_title_uid, new_title: item.new_title, success: false, error: 'page_title_uid and new_title are required' });
        continue;
      }

      // Resolve UID
      let pageUid = await findUidByTitle(pageKey);
      if (!pageUid) {
        const directUidQuery = `[:find ?uid . :where [?e :block/uid "${pageKey}"] [?e :block/uid ?uid]]`;
        const d = await q(this.graph, directUidQuery, [], this.limiter);
        pageUid = (d === null || d === undefined) ? null : String(d);
      }
      if (!pageUid) {
        results.push({ page_title_uid: item.page_title_uid, new_title: item.new_title, success: false, error: `Page "${pageKey}" not found` });
        continue;
      }

      // Get current title
      const oldTitleRaw2 = await q(this.graph, `[:find ?title . :in $ ?uid :where [?e :block/uid ?uid] [?e :node/title ?title]]`, [pageUid], this.limiter);
      const oldTitle = (oldTitleRaw2 === null || oldTitleRaw2 === undefined) ? null : String(oldTitleRaw2);
      if (!oldTitle) {
        results.push({ page_title_uid: item.page_title_uid, new_title: item.new_title, success: false, error: `Could not resolve current title for UID ${pageUid}` });
        continue;
      }

      if (oldTitle === targetTitle) {
        results.push({ page_title_uid: item.page_title_uid, page_uid: pageUid, old_title: oldTitle, new_title: targetTitle, success: true });
        continue;
      }

      const existingUid = await findUidByTitle(targetTitle);
      if (existingUid && item.allow_merge !== true) {
        results.push({ page_title_uid: item.page_title_uid, new_title: targetTitle, success: false, error: `Target title exists: "${targetTitle}" (set allow_merge=true)` });
        continue;
      }

      actions.push({
        action: 'update-page',
        page: {
          uid: pageUid,
          title: targetTitle,
          ...(item.children_view_type ? { 'children-view-type': item.children_view_type } : {})
        }
      });

      results.push({ page_title_uid: item.page_title_uid, page_uid: pageUid, old_title: oldTitle, new_title: targetTitle, success: true, ...(existingUid ? { merged: true } : {}) });
    }

    if (actions.length === 0) {
      return { success: results.every(r => r.success), results };
    }

    // Execute batch update-page actions
    try {
      await batchActions(this.graph, { action: 'batch-actions', actions: actions as any }, this.limiter);
      return { success: results.every(r => r.success), results };
    } catch (error: any) {
      // Mark all previously successful items as failed due to batch failure
      for (const r of results) {
        if (r.success) {
          r.success = false;
          r.error = `Batch rename failed: ${error.message}`;
        }
      }
      return { success: false, results };
    }
  }

  async fetchPageByTitle(title: string): Promise<string> {
    if (!title) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'title is required'
      );
    }

    // Try different case variations
    const variations = [
      title, // Original
      capitalizeWords(title), // Each word capitalized
      title.toLowerCase() // All lowercase
    ];

    let uid: string | null = null;
    for (const variation of variations) {
      const searchQuery = `[:find ?uid .
                          :where [?e :node/title "${variation}"]
                                 [?e :block/uid ?uid]]`;
      const result = await q(this.graph, searchQuery, [], this.limiter);
      uid = (result === null || result === undefined) ? null : String(result);
      if (uid) break;
    }

    if (!uid) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Page with title "${title}" not found (tried original, capitalized words, and lowercase)`
      );
    }

    // Define ancestor rule for traversing block hierarchy
    const ancestorRule = `[
      [ (ancestor ?b ?a)
        [?a :block/children ?b] ]
      [ (ancestor ?b ?a)
        [?parent :block/children ?b]
        (ancestor ?parent ?a) ]
    ]`;

    // Get all blocks under this page using ancestor rule
    const blocksQuery = `[:find ?block-uid ?block-str ?order ?parent-uid
                        :in $ % ?page-title
                        :where [?page :node/title ?page-title]
                               [?block :block/string ?block-str]
                               [?block :block/uid ?block-uid]
                               [?block :block/order ?order]
                               (ancestor ?block ?page)
                               [?parent :block/children ?block]
                               [?parent :block/uid ?parent-uid]]`;
    const blocks = await q(this.graph, blocksQuery, [ancestorRule, title], this.limiter);

    if (!blocks || blocks.length === 0) {
      return `${title} (no content found)`;
    }

    // Create a map of all blocks
    const blockMap = new Map<string, RoamBlock>();
    const rootBlocks: RoamBlock[] = [];

    // First pass: Create all block objects
    for (const [blockUid, blockStr, order, parentUid] of blocks) {
      const resolvedString = await resolveRefs(this.graph, blockStr);
      const block = {
        uid: blockUid,
        string: resolvedString,
        order: order as number,
        children: []
      };
      blockMap.set(blockUid, block);
      
      // If no parent or parent is the page itself, it's a root block
      if (!parentUid || parentUid === uid) {
        rootBlocks.push(block);
      }
    }

    // Second pass: Build parent-child relationships
    for (const [blockUid, _, __, parentUid] of blocks) {
      if (parentUid && parentUid !== uid) {
        const child = blockMap.get(blockUid);
        const parent = blockMap.get(parentUid);
        if (child && parent && !parent.children.includes(child)) {
          parent.children.push(child);
        }
      }
    }

    // Sort blocks recursively
    const sortBlocks = (blocks: RoamBlock[]) => {
      blocks.sort((a, b) => a.order - b.order);
      blocks.forEach(block => {
        if (block.children.length > 0) {
          sortBlocks(block.children);
        }
      });
    };
    sortBlocks(rootBlocks);

    // Convert to markdown with proper nesting
    const toMarkdown = (blocks: RoamBlock[], level: number = 0): string => {
      return blocks.map(block => {
        const indent = '  '.repeat(level);
        let md = `${indent}- ${block.string}`;
        if (block.children.length > 0) {
          md += '\n' + toMarkdown(block.children, level + 1);
        }
        return md;
      }).join('\n');
    };

    return `# ${title}\n\n${toMarkdown(rootBlocks)}`;
  }
}

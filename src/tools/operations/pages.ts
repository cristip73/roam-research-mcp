import type { Graph } from '@roam-research/roam-api-sdk';
import { q, createPage as createRoamPage, batchActions, createBlock } from '../../utils/roam-api-wrapper.js';
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
            const actions = [];
            
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
                actions
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

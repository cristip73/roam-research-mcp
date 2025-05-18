import { q } from '@roam-research/roam-api-sdk';
import type { Graph } from '@roam-research/roam-api-sdk';
import { BaseSearchHandler, SearchResult } from './types.js';
import { SearchUtils } from './utils.js';
import { resolveRefs } from '../tools/helpers/refs.js';

// Interfață pentru obiectele care conțin proprietatea 'order'
interface Ordered {
  order: number;
  string: string;
  uid: string;
  children?: Ordered[];
}

export interface IndentedHierarchyParams {
  parent_uid?: string;
  child_uid?: string;
  page_title_uid?: string;
  max_depth?: number;
  part?: number; // Pentru a specifica ce parte a unui rezultat divizat să returneze
}

// Structura pentru stocarea blocurilor din ierarhie
interface BlockNode {
  uid: string;
  string: string;
  order: number;
  children?: BlockNode[];
}

interface RawBlock {
  ':block/string'?: string;
  ':block/uid': string;
  ':block/order'?: number;
  ':block/children'?: RawBlock[];
}

function normalizeBlock(raw: RawBlock): BlockNode {
  return {
    uid: raw[":block/uid"],
    string: raw[":block/string"] || "",
    order: raw[":block/order"] ?? 0,
    children: raw[":block/children"]?.map(normalizeBlock),
  };
}

export class IndentedHierarchyHandler extends BaseSearchHandler {
  constructor(
    graph: Graph,
    private params: IndentedHierarchyParams
  ) {
    super(graph);
  }

  /**
   * Împarte un text în părți, cu o dimensiune maximă specificată per parte.
   * @param text Textul de împărțit
   * @param maxSize Dimensiunea maximă pentru fiecare parte
   * @returns Array de părți de text
   */
  private splitTextIntoParts(text: string, maxSize: number = 10000): string[] {
    const parts: string[] = [];
    let remainingText = text;
    
    while (remainingText.length > 0) {
      if (remainingText.length <= maxSize) {
        parts.push(remainingText);
        break;
      }
      
      // Găsim ultimul caracter newline înainte de limita de maxSize
      // pentru a nu tăia liniile în mijloc
      let cutPoint = remainingText.lastIndexOf('\n', maxSize);
      if (cutPoint === -1 || cutPoint < maxSize * 0.8) {
        // Dacă nu găsim un newline convenabil, tăiem la maxSize
        cutPoint = maxSize;
      }
      
      parts.push(remainingText.substring(0, cutPoint));
      remainingText = remainingText.substring(cutPoint);
    }
    
    return parts;
  }

  async execute(): Promise<SearchResult> {
    const { parent_uid, child_uid, page_title_uid, max_depth = 1, part = 1 } = this.params;

    // Limităm adâncimea maximă pentru a preveni interogări prea complexe
    const effectiveMaxDepth = Math.min(max_depth, 7);

    if (!parent_uid && !child_uid) {
      return {
        success: false,
        matches: [],
        message: 'Either parent_uid or child_uid must be provided'
      };
    }

    try {
      let indentedList = "";
      let totalBlocks = 0;

      // Abordare descendentă (parent_uid)
      if (parent_uid) {
        const pattern = this.buildPullPattern(effectiveMaxDepth);
        const pullQuery = `[:find (pull ?b ${pattern}) .\n                          :in $ ?uid\n                          :where [?b :block/uid ?uid]]`;
        const result = await q(this.graph, pullQuery, [parent_uid]);
        if (!result) {
          return {
            success: false,
            matches: [],
            message: `Block with UID ${parent_uid} not found`
          };
        }
        const rootBlock = normalizeBlock(result as unknown as RawBlock);
        const treeResult = await this.processTree([rootBlock], 0, effectiveMaxDepth, "");
        indentedList = treeResult.indentedText;
        totalBlocks = treeResult.totalBlocks;
      }
      else if (child_uid) {
        // 1. Obținem blocul copil
        const childQuery = `[:find ?string
                           :in $ ?uid
                           :where [?b :block/uid ?uid]
                                  [?b :block/string ?string]]`;
        
        const childResults = await q(this.graph, childQuery, [child_uid]) as [string][];
        if (childResults.length === 0) {
          return {
            success: false,
            matches: [],
            message: `Block with UID ${child_uid} not found`
          };
        }

        const childContent = await resolveRefs(this.graph, childResults[0][0]);
        
        // 2. Identificăm lanțul de părinți
        const ancestors = [];
        let currentChildUid = child_uid;
        let currentDepth = 0;
        
        while (currentDepth < effectiveMaxDepth) {
          const parentQuery = `[:find ?parent-uid ?parent-string
                              :in $ ?child-uid
                              :where [?child :block/uid ?child-uid]
                                     [?parent :block/children ?child]
                                     [?parent :block/uid ?parent-uid]
                                     [?parent :block/string ?parent-string]]`;
          
          const parentResults = await q(this.graph, parentQuery, [currentChildUid]) as [string, string][];
          
          if (parentResults.length === 0) {
            break; // Nu mai există părinți
          }
          
          const [parentUid, parentString] = parentResults[0];
          const parentContent = await resolveRefs(this.graph, parentString);
          
          ancestors.push({
            uid: parentUid,
            content: parentContent
          });
          
          // Pregătim pentru următoarea iterație
          currentChildUid = parentUid;
          currentDepth++;
        }
        
        // Inversăm lanțul pentru a afișa de la strămoși la părinți
        ancestors.reverse();
        
        // 3. Construim lista indentată
        if (ancestors.length === 0) {
          // Nu are părinți, afișăm doar blocul curent
          indentedList = `- ${childContent}\n`;
          totalBlocks = 1;
        } else {
          // Are părinți, afișăm întregul lanț
          for (let i = 0; i < ancestors.length; i++) {
            const indent = "  ".repeat(i);
            indentedList += `${indent}- ${ancestors[i].content}\n`;
          }
          
          // Adăugăm blocul copil la sfârșitul lanțului
          const childIndent = "  ".repeat(ancestors.length);
          indentedList += `${childIndent}- ${childContent}\n`;
          
          totalBlocks = ancestors.length + 1;
        }
      }

      // Verificăm dacă trebuie să împărțim rezultatul în părți
      if (indentedList.length > 10000) {
        const parts = this.splitTextIntoParts(indentedList);
        const totalParts = parts.length;
        const requestedPart = Math.min(Math.max(1, part), totalParts);
        
        // Calculăm care parte trebuie să o returnăm
        const partToReturn = parts[requestedPart - 1];
        
        let message = `Found ${totalBlocks} blocks in hierarchy. `;
        if (totalParts > 1) {
          message += `Result split into ${totalParts} parts. Showing part ${requestedPart} of ${totalParts}.`;
          message += ` Use 'part' parameter (1-${totalParts}) to view other parts.`;
        }
        
        return {
          success: true,
          matches: [{
            block_uid: "indented_hierarchy",
            content: partToReturn,
            is_indented_hierarchy: true,
            total_parts: totalParts,
            current_part: requestedPart
          }],
          message: message
        };
      }

      // Caz normal, returnăm întregul rezultat
      return {
        success: true,
        matches: [{
          block_uid: "indented_hierarchy",
          content: indentedList,
          is_indented_hierarchy: true
        }],
        message: `Found ${totalBlocks} blocks in hierarchy`
      };

    } catch (error) {
      console.error('Error in indented hierarchy search:', error);
      return {
        success: false,
        matches: [],
        message: `Error processing hierarchy: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Procesează recursiv arborele de blocuri și generează textul indentat
   * @param blocks Array de blocuri de procesat
   * @param level Nivelul curent de adâncime în ierarhie
   * @param maxDepth Adâncimea maximă până la care să procesăm
   * @param indent Șirul de indentare curent
   */
  private async processTree(
    blocks: any[],
    level: number,
    maxDepth: number,
    indent: string = "  "
  ): Promise<{ indentedText: string; totalBlocks: number }> {
    if (!blocks || blocks.length === 0 || level > maxDepth) {
      return { indentedText: "", totalBlocks: 0 };
    }

    let indentedText = "";
    let totalBlocks = 0;
    
    // Sortăm blocurile după ordinea lor
    const sortedBlocks = [...blocks].sort((a, b) => {
      // Gestiunea cazului când order ar putea lipsi
      const orderA = a.order !== undefined ? a.order : 0;
      const orderB = b.order !== undefined ? b.order : 0;
      return orderA - orderB;
    });
    
    // Rezolvăm toate referințele într-un singur batch pentru eficiență
    const blockContents = await Promise.all(
      sortedBlocks.map(block => resolveRefs(this.graph, block.string || ""))
    );
    
    // Procesăm fiecare bloc
    for (let i = 0; i < sortedBlocks.length; i++) {
      const block = sortedBlocks[i];
      const content = blockContents[i];
      
      // Adăugăm blocul curent la textul indentat
      indentedText += `${indent}- ${content}\n`;
      totalBlocks++;
      
      // Procesăm recursiv copiii, dacă există și nu am atins adâncimea maximă
      if (block.children && block.children.length > 0 && level < maxDepth) {
        const childResult = await this.processTree(
          block.children,
          level + 1,
          maxDepth,
          indent + "  "
        );
        
        indentedText += childResult.indentedText;
        totalBlocks += childResult.totalBlocks;
      }
    }
    
    return { indentedText, totalBlocks };
  }

  /**
   * Generează pattern-ul pentru interogarea Datomic în funcție de adâncimea dorită
   */
  private buildPullPattern(depth: number): string {
    let pattern = '[:block/string :block/uid :block/order';
    
    if (depth > 1) {
      pattern += ' {:block/children ';
      let currentDepth = 2;
      
      while (currentDepth <= depth) {
        pattern += '[:block/string :block/uid :block/order';
        
        if (currentDepth < depth) {
          pattern += ' {:block/children ';
        } else {
          pattern += ']';
          break;
        }
        
        currentDepth++;
      }
      
      // Închidem acoladele deschise
      for (let i = 2; i < depth; i++) {
        pattern += '}]';
      }
      
      pattern += '}]';
    } else {
      pattern += ']';
    }
    
    return pattern;
  }
} 
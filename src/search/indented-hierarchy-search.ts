import { q } from '@roam-research/roam-api-sdk';
import type { Graph } from '@roam-research/roam-api-sdk';
import { BaseSearchHandler, SearchResult } from './types.js';
import { SearchUtils } from './utils.js';
import { resolveRefs } from '../tools/helpers/refs.js';

export interface IndentedHierarchyParams {
  parent_uid?: string;
  child_uid?: string;
  page_title_uid?: string;
  max_depth?: number;
}

// Interface to represent node in the hierarchy tree
interface HierarchyNode {
  uid: string;
  content: string;
  order: number;
  depth: number;
  children: HierarchyNode[];
}

export class IndentedHierarchyHandler extends BaseSearchHandler {
  constructor(
    graph: Graph,
    private params: IndentedHierarchyParams
  ) {
    super(graph);
  }

  async execute(): Promise<SearchResult> {
    const { parent_uid, child_uid, page_title_uid, max_depth = 1 } = this.params;

    // Limităm adâncimea maximă pentru a preveni interogări prea complexe
    const effectiveMaxDepth = Math.min(max_depth, 5);

    if (!parent_uid && !child_uid) {
      return {
        success: false,
        matches: [],
        message: 'Either parent_uid or child_uid must be provided'
      };
    }

    // Get target page UID if provided
    let targetPageUid: string | undefined;
    if (page_title_uid) {
      targetPageUid = await SearchUtils.findPageByTitleOrUid(this.graph, page_title_uid);
    }

    // If we're searching for descendants (using parent_uid)
    if (parent_uid) {
      try {
        // First, get the root block's content
        const rootBlockQuery = `[:find ?content
                               :in $ ?block-uid
                               :where [?b :block/uid ?block-uid]
                                      [?b :block/string ?content]]`;
        
        const rootResults = await q(this.graph, rootBlockQuery, [parent_uid]) as [string][];
        if (!rootResults.length) {
          return {
            success: false,
            matches: [],
            message: `Block with UID ${parent_uid} not found`
          };
        }

        const rootContent = rootResults[0][0];
        const resolvedRootContent = await resolveRefs(this.graph, rootContent);
        
        // Implementăm o abordare iterativă mai eficientă, nivel cu nivel
        // Mai întâi obținem copiii direcți ai nodului rădăcină
        const directChildrenQuery = `[:find ?uid ?content ?order
                                   :in $ ?parent-uid
                                   :where [?parent :block/uid ?parent-uid]
                                          [?parent :block/children ?child]
                                          [?child :block/uid ?uid]
                                          [?child :block/string ?content]
                                          [?child :block/order ?order]]`;
        
        const directChildren = await q(this.graph, directChildrenQuery, [parent_uid]) as [string, string, number][];
        
        // Construim arborele inițial cu rădăcina și copiii direcți
        const nodeMap = new Map<string, HierarchyNode>();
        const rootNode: HierarchyNode = {
          uid: parent_uid,
          content: resolvedRootContent,
          order: 0,
          depth: 0,
          children: []
        };
        nodeMap.set(parent_uid, rootNode);
        
        // Adăugăm copiii direcți
        const directNodesPromises = directChildren.map(async ([uid, content, order]) => {
          const resolvedContent = await resolveRefs(this.graph, content);
          const node: HierarchyNode = {
            uid,
            content: resolvedContent,
            order,
            depth: 1,
            children: []
          };
          nodeMap.set(uid, node);
          return node;
        });
        
        const directNodes = await Promise.all(directNodesPromises);
        
        // Sortăm copiii după ordinea lor
        directNodes.sort((a, b) => a.order - b.order);
        rootNode.children = directNodes;
        
        // Dacă adâncimea maximă este mai mare decât 1, continuăm adăugarea nivelurilor aditionale
        if (effectiveMaxDepth > 1) {
          // Obținem restul nivelurilor până la adâncimea maximă
          // Folosim o abordare iterativă în loc de o interogare recursivă complexă
          let currentParents = directNodes;
          let currentDepth = 1;
          
          while (currentParents.length > 0 && currentDepth < effectiveMaxDepth) {
            const nextParents = [];
            
            // Pentru fiecare părinte de la nivelul curent, obținem copiii săi
            for (const parent of currentParents) {
              const childrenQuery = `[:find ?uid ?content ?order
                                   :in $ ?parent-uid
                                   :where [?parent :block/uid ?parent-uid]
                                          [?parent :block/children ?child]
                                          [?child :block/uid ?uid]
                                          [?child :block/string ?content]
                                          [?child :block/order ?order]]`;
              
              const children = await q(this.graph, childrenQuery, [parent.uid]) as [string, string, number][];
              
              // Procesăm copiii
              const childNodesPromises = children.map(async ([uid, content, order]) => {
                const resolvedContent = await resolveRefs(this.graph, content);
                const node: HierarchyNode = {
                  uid,
                  content: resolvedContent,
                  order,
                  depth: currentDepth + 1,
                  children: []
                };
                nodeMap.set(uid, node);
                return node;
              });
              
              const childNodes = await Promise.all(childNodesPromises);
              
              // Sortăm și adăugăm copiii la părintele lor
              childNodes.sort((a, b) => a.order - b.order);
              parent.children = childNodes;
              
              // Adăugăm acești copii la următorul nivel de părinți
              nextParents.push(...childNodes);
            }
            
            currentParents = nextParents;
            currentDepth++;
          }
        }
        
        // Generăm lista indentată
        let indentedList = `- ${rootNode.content}\n`;
        indentedList += this.generateIndentedList(rootNode.children, 1);
        
        // Truncate if necessary
        if (indentedList.length > 5000) {
          indentedList = indentedList.substring(0, 4997) + "...";
        }
        
        // Calculăm numărul total de blocuri
        let totalBlocks = 1; // rădăcina
        const countNodes = (node: HierarchyNode): number => {
          let count = 1;
          for (const child of node.children) {
            count += countNodes(child);
          }
          return count;
        };
        totalBlocks = countNodes(rootNode);
        
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
        return {
          success: false,
          matches: [],
          message: `Error processing hierarchy: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    } else {
      // Pentru căutarea ascendenților (când avem child_uid)
      try {
        // Prima dată, obținem conținutul blocului copil
        const childBlockQuery = `[:find ?content
                                :in $ ?block-uid
                                :where [?b :block/uid ?block-uid]
                                       [?b :block/string ?content]]`;
        
        const childResults = await q(this.graph, childBlockQuery, [child_uid]) as [string][];
        if (!childResults.length) {
          return {
            success: false,
            matches: [],
            message: `Block with UID ${child_uid} not found`
          };
        }

        const childContent = childResults[0][0];
        const resolvedChildContent = await resolveRefs(this.graph, childContent);
        
        // Căutăm părintele direct
        const parentQuery = `[:find ?uid ?content ?order
                            :in $ ?child-uid
                            :where [?child :block/uid ?child-uid]
                                   [?parent :block/children ?child]
                                   [?parent :block/uid ?uid]
                                   [?parent :block/string ?content]
                                   [?parent :block/order ?order]]`;
        
        const parentResults = await q(this.graph, parentQuery, [child_uid]) as [string, string, number][];
        
        // Dacă nu există părinte, returnăm doar copilul
        if (parentResults.length === 0) {
          return {
            success: true,
            matches: [{
              block_uid: "indented_hierarchy",
              content: `- ${resolvedChildContent}\n`,
              is_indented_hierarchy: true
            }],
            message: "Found 1 block (no parents)"
          };
        }
        
        // Procesăm părintele direct
        const [parentUid, parentContent, parentOrder] = parentResults[0];
        const resolvedParentContent = await resolveRefs(this.graph, parentContent);
        
        // Construim o listă de strămoși, începând cu părintele direct
        const ancestors = [{
          uid: parentUid,
          content: resolvedParentContent,
          depth: 1
        }];
        
        // Iterăm pentru a găsi restul strămoșilor până la adâncimea maximă
        let currentUid = parentUid;
        let currentDepth = 1;
        
        while (currentDepth < effectiveMaxDepth) {
          // Căutăm părintele nivelului curent
          const grandparentQuery = `[:find ?uid ?content ?order
                                  :in $ ?child-uid
                                  :where [?child :block/uid ?child-uid]
                                         [?parent :block/children ?child]
                                         [?parent :block/uid ?uid]
                                         [?parent :block/string ?content]
                                         [?parent :block/order ?order]]`;
          
          const grandparentResults = await q(this.graph, grandparentQuery, [currentUid]) as [string, string, number][];
          
          // Dacă nu mai există părinți, ieșim din buclă
          if (grandparentResults.length === 0) {
            break;
          }
          
          const [gpUid, gpContent, gpOrder] = grandparentResults[0];
          const resolvedGpContent = await resolveRefs(this.graph, gpContent);
          
          // Adăugăm strămoșul la listă
          ancestors.push({
            uid: gpUid,
            content: resolvedGpContent,
            depth: currentDepth + 1
          });
          
          // Pregătim pentru următoarea iterație
          currentUid = gpUid;
          currentDepth++;
        }
        
        // Inversăm lista pentru a avea strămoșul cel mai îndepărtat primul
        ancestors.reverse();
        
        // Generăm lista indentată
        let indentedList = "";
        
        // Adăugăm strămoșii
        for (let i = 0; i < ancestors.length; i++) {
          const indent = "  ".repeat(i);
          indentedList += `${indent}- ${ancestors[i].content}\n`;
        }
        
        // Adăugăm copilul
        const childIndent = "  ".repeat(ancestors.length);
        indentedList += `${childIndent}- ${resolvedChildContent}\n`;
        
        // Truncare dacă e necesar
        if (indentedList.length > 5000) {
          indentedList = indentedList.substring(0, 4997) + "...";
        }
        
        return {
          success: true,
          matches: [{
            block_uid: "indented_hierarchy",
            content: indentedList,
            is_indented_hierarchy: true
          }],
          message: `Found ${ancestors.length + 1} blocks in ancestor hierarchy`
        };
      } catch (error) {
        return {
          success: false,
          matches: [],
          message: `Error processing ancestor hierarchy: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
  }

  // Helper method to recursively generate the indented list
  private generateIndentedList(nodes: HierarchyNode[], level: number): string {
    let result = "";
    for (const node of nodes) {
      const indent = "  ".repeat(level);
      result += `${indent}- ${node.content}\n`;
      if (node.children.length > 0) {
        result += this.generateIndentedList(node.children, level + 1);
      }
    }
    return result;
  }
} 
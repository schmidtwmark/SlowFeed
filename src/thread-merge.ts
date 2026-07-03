import type { DigestPost } from './types/index.js';

/**
 * Shared thread-tree merging for sources that reconstruct reply threads
 * (Bluesky, Mastodon). Each timeline reply produces a linear chain
 * (root → ... → leaf); these helpers collapse overlapping chains into a
 * single tree per conversation.
 */

/**
 * Recursively merge an incoming thread tree into an existing one.
 * Walks both trees in parallel, matching children by postId.
 * New children are inserted; existing children are merged recursively.
 */
export function mergeIntoTree(existing: DigestPost, incoming: DigestPost): void {
  if (!incoming.replies) return;

  for (const incomingReply of incoming.replies) {
    const existingReply = existing.replies?.find(r => r.postId === incomingReply.postId);

    if (existingReply) {
      // Same post exists at this level — recurse to merge their children
      mergeIntoTree(existingReply, incomingReply);
    } else if (existing.replies) {
      existing.replies.push(incomingReply);
    } else {
      existing.replies = [incomingReply];
    }
  }
}

/** Depth-first search for a node by postId anywhere in a thread tree. */
export function findNode(tree: DigestPost, postId: string): DigestPost | null {
  if (tree.postId === postId) return tree;
  for (const reply of tree.replies ?? []) {
    const found = findNode(reply, postId);
    if (found) return found;
  }
  return null;
}

/**
 * Merge digest posts that share the same root postId, then absorb any
 * thread whose "root" is actually a node INSIDE another thread.
 *
 * The absorption pass handles chains that stopped short of the true root
 * (a failed ancestor fetch, or a conversation deeper than the API's
 * parent-walk limit): such a chain is rooted mid-conversation, so its
 * root won't match the full chain's root — but it IS reachable inside
 * the full tree. Without this pass the digest shows two overlapping
 * copies of the same thread.
 */
export function mergeThreadsByRoot(posts: DigestPost[]): DigestPost[] {
  const rootMap = new Map<string, DigestPost>();
  const order: string[] = [];

  for (const post of posts) {
    const rootId = post.postId;

    if (!rootMap.has(rootId)) {
      rootMap.set(rootId, post);
      order.push(rootId);
    } else {
      mergeIntoTree(rootMap.get(rootId)!, post);
    }
  }

  // Absorption pass. Loop to fixpoint: absorbing tree Y into X can make a
  // third tree Z's root reachable inside X on the next sweep.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...order]) {
      const candidate = rootMap.get(id)!;
      for (const hostId of order) {
        if (hostId === id) continue;
        const host = rootMap.get(hostId)!;
        const node = findNode(host, id);
        if (node) {
          // candidate's root already lives inside host — graft its children
          // onto that node and drop the duplicate top-level thread.
          mergeIntoTree(node, candidate);
          rootMap.delete(id);
          order.splice(order.indexOf(id), 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return order.map(id => rootMap.get(id)!);
}

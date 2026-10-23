import { FuzzyPathIndex } from "@/core/workspace/fuzzy";
import type { FuzzySearchRequest, FuzzySearchResponse } from "./fuzzySearchClient";

let index = new FuzzyPathIndex([]);
let generation = 0;
self.onmessage = (event: MessageEvent<FuzzySearchRequest>) => {
  const request = event.data;
  const current = ++generation;
  if (request.paths) index = new FuzzyPathIndex(request.paths);
  const source = index;
  void source.rankAsync(request.query, request.limit, () => current !== generation)
    .then((matches) => {
      if (current !== generation) return;
      self.postMessage({ id: request.id, matches } satisfies FuzzySearchResponse);
    })
    .catch(() => {
      if (current === generation) self.postMessage({ id: request.id, error: true } satisfies FuzzySearchResponse);
    });
};

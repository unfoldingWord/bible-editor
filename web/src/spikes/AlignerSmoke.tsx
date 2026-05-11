// ============================================================================
// SPIKE FINDING (2026-05-11): KNOWN BUILD ISSUE
// ============================================================================
// This component does NOT currently build under Vite/Rollup. It builds fine
// under webpack (which is what gatewayEdit uses). The aligner package's deep
// dependency tree mixes core-js v2 paths (from babel-runtime, e.g.
// `core-js/library/fn/get-iterator`) with v3 paths (`core-js/modules/es.symbol.js`)
// in different sibling packages. Webpack tolerates this mix; Rollup hard-fails
// when an import resolves to the wrong version.
//
// Workarounds investigated (all leave residual risk):
//   - resolve.alias core-js → v3 only: breaks legacy `core-js/library/fn/*`
//     imports in word-aligner-lib's nested word-aligner.
//   - npm `overrides` to force core-js@3: same problem, deeper.
//   - Build the aligner as a webpack UMD bundle and load via <script>: viable
//     but adds a parallel build pipeline.
//   - Replace with a custom aligner UI built on react-dnd against the same
//     {verseAlignments, targetWords} data model: probably the cheapest path
//     for a 7-month tool. The alignment editor is ~300 LOC of drag-drop.
//
// File excluded from tsconfig.json and not imported from anywhere in the live
// app — kept for context when Phase 3 picks this up. See docs/plan.md.
// ============================================================================

import { useState } from "react";
import { Box, Button, Typography, Alert } from "@mui/material";
// @ts-expect-error — aligner ships JS only; see web/src/types/modules.d.ts
import { SuggestingWordAligner } from "enhanced-word-aligner-rcl";

// Sample data structure based on word-aligner-rcl's API surface — a real
// integration will feed verseAlignments/targetWords from a usfm-js verse
// JSON tree (see spikes/usfm-roundtrip.mjs).
const sampleTargetTokens = [
  { text: "The", occurrence: 1, occurrences: 1, index: 0 },
  { text: "vision", occurrence: 1, occurrences: 1, index: 1 },
  { text: "of", occurrence: 1, occurrences: 1, index: 2 },
  { text: "Obadiah", occurrence: 1, occurrences: 1, index: 3 },
];

const sampleVerseAlignments = [
  {
    sourceNgram: [
      { text: "חֲזוֹן", occurrence: 1, occurrences: 1, strong: "H2377", lemma: "חָזוֹן", morph: "He,Ncmsc" },
    ],
    targetNgram: [] as Array<{ text: string; occurrence: number; occurrences: number; index: number }>,
  },
];

export function AlignerSmoke() {
  const [error, setError] = useState<string | null>(null);
  try {
    return (
      <Box sx={{ p: 2, border: "1px dashed", borderColor: "divider", borderRadius: 1, mt: 2 }}>
        <Typography variant="subtitle1" gutterBottom>
          Aligner smoke — SuggestingWordAligner from enhanced-word-aligner-rcl
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <Box sx={{ fontSize: 13 }}>
          <SuggestingWordAligner
            verseAlignments={sampleVerseAlignments}
            targetWords={sampleTargetTokens}
            translate={(s: string) => s}
            contextId={{ reference: { bookId: "oba", chapter: 1, verse: 1 } }}
            sourceLanguage="he"
            sourceLanguageFont=""
            targetLanguage={{ id: "en", direction: "ltr", name: "English" }}
            targetLanguageFont=""
            lexicons={{}}
            loadLexiconEntry={() => Promise.resolve({})}
            onChange={() => {
              /* placeholder */
            }}
            showPopover={() => {
              /* placeholder */
            }}
            styles={{}}
            asyncSuggester={async () => []}
            hasRenderedSuggestions={false}
          />
        </Box>
        {!error && (
          <Button sx={{ mt: 1 }} size="small" onClick={() => setError("force-render of error path")}>
            test error path
          </Button>
        )}
      </Box>
    );
  } catch (e) {
    return <Alert severity="error">aligner mount threw: {String(e)}</Alert>;
  }
}

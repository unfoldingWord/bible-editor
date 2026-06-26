// Centered popup that renders a Translation Words article inline instead of
// sending the editor to a new Door43 tab. Fetches raw markdown on open and
// renders it with react-markdown; internal links resolve to Door43 (new tab).

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  Box,
  Typography,
  IconButton,
  Link,
  CircularProgress,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchTwArticle, twArticleDcsUrl, twShort } from "../lib/twArticle";

interface Props {
  articleId: string | null;
  onClose: () => void;
}

// First "# Heading" line is the article's display name ("vision, envision").
function titleFromMarkdown(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : fallback;
}

// Articles link to siblings via relative paths (../kt/god.md) and to other
// resources via rc:// URIs. Resolve relative paths against the Door43 source
// page; render non-navigable rc:// references as plain text.
function mdLink(baseUrl: string) {
  return function MdLink({ href, children }: { href?: string; children?: React.ReactNode }) {
    if (!href) return <>{children}</>;
    let resolved: string | null = null;
    if (/^https?:\/\//.test(href)) {
      resolved = href;
    } else if (/\.md(#.*)?$/.test(href) || href.startsWith("./") || href.startsWith("../")) {
      try {
        resolved = new URL(href, baseUrl).href;
      } catch {
        resolved = null;
      }
    }
    if (!resolved) {
      return (
        <Typography component="span" sx={{ color: "text.secondary" }}>
          {children}
        </Typography>
      );
    }
    return (
      <Link href={resolved} target="_blank" rel="noopener noreferrer">
        {children}
      </Link>
    );
  };
}

export function TwArticleDialog({ articleId, onClose }: Props) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!articleId) return;
    let cancelled = false;
    setMarkdown(null);
    setError(false);
    fetchTwArticle(articleId)
      .then((md) => {
        if (!cancelled) setMarkdown(md);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  const open = articleId !== null;
  const dcsUrl = twArticleDcsUrl(articleId);
  const title = markdown ? titleFromMarkdown(markdown, twShort(articleId)) : twShort(articleId);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth scroll="paper">
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          px: 3,
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="h6" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
          {dcsUrl && (
            <Link href={dcsUrl} target="_blank" rel="noopener noreferrer" variant="body2" underline="hover">
              View on DCS
            </Link>
          )}
          <IconButton size="small" onClick={onClose} aria-label="close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>
      <DialogContent dividers>
        {error ? (
          <Typography color="error" variant="body2">
            Couldn&rsquo;t load this article.{" "}
            {dcsUrl && (
              <Link href={dcsUrl} target="_blank" rel="noopener noreferrer">
                Open on Door43
              </Link>
            )}
          </Typography>
        ) : markdown === null ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <Box
            sx={{
              "& h1": { typography: "h5", mt: 0, mb: 1.5 },
              "& h2": { typography: "h6", mt: 2.5, mb: 1 },
              "& h3": { typography: "subtitle1", fontWeight: 600, mt: 2, mb: 0.5 },
              "& p": { typography: "body1", my: 1 },
              "& ul, & ol": { pl: 3, my: 1 },
              "& li": { typography: "body1", my: 0.5 },
              "& a": { color: "primary.main" },
            }}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ a: mdLink(dcsUrl) }}
            >
              {markdown}
            </ReactMarkdown>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

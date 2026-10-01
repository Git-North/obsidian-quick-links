import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { editorLivePreviewField } from "obsidian";
import { QuickLinksSettings, getQuickLinksMap } from "./settings";
import { QuickLinkMacro, RawLink, transformLink } from "./quick-links";

interface QuickLinkSlice {
  linkToInsert: RawLink;
  externalLink: boolean;
  from: number;
  to: number;

  // The part of the source that should be displayed as the link text.
  displayFrom: number;
  displayTo: number;
}

interface LinkPattern {
  debugName: string;
  nodes: string[];
  textIndex: number | null;
  targetIndex: number;
  checkForEm: boolean;
  isExternalLink: boolean;
}

const WIKI_LINK_PATTERNS: LinkPattern[] = [
  {
    debugName: "plain_wikilink",
    nodes: [
      "formatting-link_formatting-link-start",
      "hmd-internal-link",
      "formatting-link_formatting-link-end",
    ],
    textIndex: null,
    targetIndex: 1,
    checkForEm: true,
    isExternalLink: false,
  },
  {
    debugName: "piped_wikilink",
    nodes: [
      "formatting-link_formatting-link-start",
      "hmd-internal-link_link-has-alias",
      "hmd-internal-link_link-alias-pipe",
      "hmd-internal-link_link-alias",
      "formatting-link_formatting-link-end",
    ],
    textIndex: 3,
    targetIndex: 1,
    checkForEm: true,
    isExternalLink: false,
  },
];

const EXTERNAL_LINK_PATTERNS: LinkPattern[] = [
  {
    debugName: "external_link",
    nodes: [
      "formatting_formatting-link_link",
      "link",
      "formatting_formatting-link_link",
      "formatting_formatting-link-string_string_url",
      "string_url",
      "formatting_formatting-link-string_string_url",
    ],
    textIndex: 1,
    targetIndex: 4,
    checkForEm: false,
    isExternalLink: true,
  },
  {
    debugName: "blank_external_link",
    nodes: [
      "formatting_formatting-link_hmd-barelink_link",
      "formatting_formatting-link-string_string_url",
      "string_url",
      "formatting_formatting-link-string_string_url",
    ],
    textIndex: null,
    targetIndex: 2,
    checkForEm: false,
    isExternalLink: true,
  },
  {
    debugName: "external_link2",
    nodes: [
      "formatting_formatting-link_link_list-2",
      "link_list-2",
      "formatting_formatting-link_link_list-2",
      "formatting_formatting-link-string_list-2_string_url",
      "list-2_string_url",
      "formatting_formatting-link-string_list-2_string_url",
    ],
    textIndex: 1,
    targetIndex: 4,
    checkForEm: false,
    isExternalLink: true,
  },
];

class LivePreviewQuickLinksPluginValue implements PluginValue {
  decorations: DecorationSet;
  private slices: QuickLinkSlice[];

  constructor(view: EditorView) {
    this.slices = [];
    this.decorations = this.buildDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  buildDecorations(view: EditorView): DecorationSet {
    if (!view.state.field(editorLivePreviewField)) {
      return Decoration.none;
    }

    const builder = new RangeSetBuilder<Decoration>();

    this.slices = [];
    this.findQuickLinks(view, this.slices);
    this.processQuickLinks(view, builder);

    return builder.finish();
  }

  findQuickLinks(
    view: EditorView,
    slices: QuickLinkSlice[],
  ): void {
    // @ts-ignore
    const settings: QuickLinksSettings =
      app.plugins.plugins["quick-links"].settings;

    const quickLinksMap = getQuickLinksMap(settings);

    const nodes: SyntaxNode[] = [];

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node: SyntaxNodeRef) => {
          nodes.push(node.node);
        },
      });
    }

    const patterns = settings.useWikiLinkSyntax
      ? WIKI_LINK_PATTERNS.concat(EXTERNAL_LINK_PATTERNS)
      : EXTERNAL_LINK_PATTERNS;

    for (const pattern of patterns) {
      for (const chunk of findChunks(nodes, pattern.nodes)) {
        const from = chunk[0].from;
        const to = chunk[chunk.length - 1].to;

        const target = view.state.sliceDoc(
          chunk[pattern.targetIndex].from,
          chunk[pattern.targetIndex].to,
        );

        const text =
          pattern.textIndex === null
            ? ""
            : view.state.sliceDoc(
                chunk[pattern.textIndex].from,
                chunk[pattern.textIndex].to,
              );

        const em = pattern.checkForEm
          ? chunk[0].name.startsWith("em")
          : false;

        const link = { text, target, em };

        const maybeLink = transformLink(link, quickLinksMap);

        if (maybeLink === null) {
          continue;
        }

        /*
         * Determine which source characters represent the visible
         * link text.
         *
         * For [[w:New York]]:
         *   displayFrom = beginning of "w:New York"
         *   displayTo   = end of "w:New York"
         *
         * For [[w:New York|NY]]:
         *   displayFrom = beginning of "NY"
         *   displayTo   = end of "NY"
         *
         * For [Buffalo](w:Buffalo):
         *   displayFrom = beginning of "Buffalo"
         *   displayTo   = end of "Buffalo"
         */
        let displayFrom: number;
        let displayTo: number;

        if (pattern.debugName === "plain_wikilink") {
          displayFrom = chunk[1].from + patternPrefixLength(
            view.state.sliceDoc(chunk[1].from, chunk[1].to),
          );
          displayTo = chunk[1].to;
        } else if (pattern.debugName === "piped_wikilink") {
          displayFrom = chunk[3].from;
          displayTo = chunk[3].to;
        } else if (
          pattern.debugName === "external_link" ||
          pattern.debugName === "external_link2"
        ) {
          displayFrom = chunk[1].from;
          displayTo = chunk[1].to;
        } else {
          // Blank external links have no visible text.
          displayFrom = chunk[0].to;
          displayTo = chunk[0].to;
        }

        slices.push({
          linkToInsert: maybeLink,
          externalLink: pattern.isExternalLink,
          from,
          to,
          displayFrom,
          displayTo,
        });
      }
    }
  }

  processQuickLinks(
    view: EditorView,
    builder: RangeSetBuilder<Decoration>,
  ): void {
    this.slices.sort((a, b) => a.from - b.from);

    const cursorHead = view.state.selection.main.head;

    for (const slice of this.slices) {
      /*
       * When the cursor is inside the link, don't decorate it.
       * This leaves the original Markdown completely editable.
       */
      if (slice.from <= cursorHead && cursorHead <= slice.to) {
        continue;
      }

      /*
       * Hide the Markdown syntax surrounding the useful text.
       *
       * We intentionally do NOT replace the whole link anymore.
       * This is the important change.
       */
      if (slice.displayFrom > slice.from) {
        builder.add(
          slice.from,
          slice.displayFrom,
          Decoration.replace({
            widget: new EmptyWidget(),
          }),
        );
      }

      if (slice.displayTo < slice.to) {
        builder.add(
          slice.displayTo,
          slice.to,
          Decoration.replace({
            widget: new EmptyWidget(),
          }),
        );
      }

      /*
       * Replace only the visible text with the actual clickable
       * external link.
       *
       * The source Markdown remains intact outside the widget.
       */
      if (slice.displayFrom < slice.displayTo) {
        builder.add(
          slice.displayFrom,
          slice.displayTo,
          Decoration.replace({
            widget: new QuickLinksWidget(slice),
          }),
        );
      }
    }
  }
}

function patternPrefixLength(target: string): number {
  const colon = target.indexOf(":");

  if (colon === -1) {
    return 0;
  }

  return colon + 1;
}

function findChunks(
  nodes: SyntaxNode[],
  pattern: string[],
): SyntaxNode[][] {
  const chunks: SyntaxNode[][] = [];

  for (let i = 0; i <= nodes.length - pattern.length; i++) {
    const chunk = nodes.slice(i, i + pattern.length);

    if (doesChunkMatch(chunk, pattern)) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

function doesChunkMatch(
  chunk: SyntaxNodeRef[],
  pattern: string[],
): boolean {
  for (let i = 0; i < chunk.length; i++) {
    if (!chunk[i].name.includes(pattern[i])) {
      return false;
    }
  }

  return true;
}

class EmptyWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "quick-links-hidden-syntax";
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class QuickLinksWidget extends WidgetType {
  private slice: QuickLinkSlice;

  constructor(slice: QuickLinkSlice) {
    super();
    this.slice = slice;
  }

  eq(other: QuickLinksWidget): boolean {
    return (
      this.slice.linkToInsert.target ===
        other.slice.linkToInsert.target &&
      this.slice.linkToInsert.text ===
        other.slice.linkToInsert.text &&
      this.slice.linkToInsert.em ===
        other.slice.linkToInsert.em
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("a");

    el.textContent = this.slice.linkToInsert.text;

    el.classList.add("external-link");

    el.setAttribute(
      "href",
      this.slice.linkToInsert.target,
    );

    el.setAttribute("rel", "noopener");
    el.setAttribute("target", "_blank");

    if (this.slice.linkToInsert.em) {
      const outer = document.createElement("em");
      outer.appendChild(el);
      return outer;
    }

    return el;
  }
}

export const LivePreviewQuickLinksPlugin =
  ViewPlugin.fromClass(
    LivePreviewQuickLinksPluginValue,
    {
      decorations: (
        value: LivePreviewQuickLinksPluginValue,
      ) => value.decorations,
    },
  );


Then add this to the plugin's styles.css:

.quick-links-hidden-syntax {
  display: none;
}

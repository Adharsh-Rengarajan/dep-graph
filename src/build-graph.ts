import { readFile, writeFile } from "fs/promises";
 
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
 
interface RawTool {
  slug: string;
  name: string;
  description: string;
  inputParameters: {
    type: string;
    properties?: Record<string, ParamSchema>;
    required?: string[];
  };
  outputParameters: unknown;
  tags?: string[];
  toolkit: { slug: string; name: string };
  isDeprecated?: boolean;
}
 
interface ParamSchema {
  type?: string;
  description?: string;
  title?: string;
  examples?: unknown[];
  enum?: unknown[];
  default?: unknown;
  items?: ParamSchema;
}
 
type Source = "user" | "tool" | "static";
type Confidence = "explicit" | "heuristic" | "low";
 
interface DependencyProfile {
  source: Source;
  required: boolean;
  satisfied_by: string[];
  confidence: Confidence;
  signal: string;
  description?: string;
}
 
interface GraphNode {
  slug: string;
  name: string;
  toolkit: string;
  group: string;
  description: string;
  isReadOnly: boolean;
}
 
interface GraphEdge {
  from: string;
  to: string;
  param: string;
  confidence: Confidence;
  signal: string;
}
 
// ---------------------------------------------------------------------------
// Sub-toolkit grouping (cosmetic — for the viewer)
// ---------------------------------------------------------------------------
 
function inferGroup(slug: string): string {
  const s = slug.toUpperCase();
  if (s.includes("GMAIL")) return "gmail";
  if (s.includes("CALENDAR") || s.includes("EVENT") || s.includes("ACL"))
    return "calendar";
  if (s.includes("DRIVE") || s.includes("FILE") || s.includes("FOLDER"))
    return "drive";
  if (s.includes("DOC")) return "docs";
  if (s.includes("SHEET") || s.includes("SPREADSHEET")) return "sheets";
  if (s.includes("SLIDE") || s.includes("PRESENTATION")) return "slides";
  if (s.includes("CONTACT") || s.includes("PEOPLE")) return "contacts";
  if (s.includes("PHOTO") || s.includes("ALBUM") || s.includes("MEDIA"))
    return "photos";
  if (s.includes("TASK")) return "tasks";
  if (s.includes("MEET")) return "meet";
  if (s.includes("PULL")) return "pulls";
  if (s.includes("ISSUE")) return "issues";
  if (s.includes("REPO")) return "repos";
  if (s.includes("ACTIONS") || s.includes("WORKFLOW")) return "actions";
  if (s.includes("TEAM")) return "teams";
  if (s.includes("ORG")) return "orgs";
  if (s.includes("USER")) return "users";
  if (s.includes("GIST")) return "gists";
  if (s.includes("RELEASE")) return "releases";
  if (s.includes("BRANCH") || s.includes("COMMIT") || s.includes("REF"))
    return "git";
  if (s.includes("SECRET") || s.includes("VARIABLE")) return "secrets";
  return "other";
}
 
function isReadOnly(tool: RawTool): boolean {
  const s = tool.slug;
  const READ =
    /(LIST|GET|FETCH|SEARCH|FIND|RETRIEVE|READ|VIEW|CHECK|COUNT|EXPORT|DOWNLOAD)/i;
  const WRITE =
    /(CREATE|UPDATE|DELETE|SEND|REPLY|FORWARD|ADD|REMOVE|MOVE|MODIFY|UPLOAD|MERGE|CLOSE|REOPEN|LOCK|UNLOCK|TRANSFER)/i;
  if (WRITE.test(s)) return false;
  if (READ.test(s)) return true;
  const tags = (tool.tags || []).map((t) => t.toLowerCase());
  if (tags.includes("destructivehint")) return false;
  if (tags.includes("readonlyhint")) return true;
  return false;
}
 
// ---------------------------------------------------------------------------
// Parameter classification
// ---------------------------------------------------------------------------
 
function paramConcept(name: string, _schema: ParamSchema): string | null {
  const n = name.toLowerCase().replace(/_/g, "");
  const map: Record<string, string> = {
    threadid: "thread", threadids: "thread",
    messageid: "message", messageids: "message",
    fileid: "file", fileids: "file",
    folderid: "folder",
    eventid: "event", eventids: "event",
    calendarid: "calendar",
    spreadsheetid: "spreadsheet",
    documentid: "document",
    presentationid: "presentation",
    albumid: "album", mediaitemid: "mediaitem",
    contactid: "contact", resourcename: "contact",
    labelid: "label", labelids: "label",
    pullnumber: "pull", issuenumber: "issue",
    commentid: "comment", reviewid: "review",
    repo: "repo", repository: "repo", repositoryid: "repo",
    owner: "user", org: "org",
    username: "user", userid: "user",
    teamslug: "team", teamid: "team",
    workflowid: "workflow", runid: "workflowrun",
    jobid: "job", artifactid: "artifact",
    sha: "commit", ref: "ref", branch: "branch", tag: "tag",
    releaseid: "release", gistid: "gist",
    discussionnumber: "discussion",
    secretname: "secret", environmentname: "environment",
    appslug: "app", installationid: "installation",
    hookid: "hook", deploymentid: "deployment",
    cardid: "card", columnid: "column",
    projectid: "project", rulesetid: "ruleset",
    checkrunid: "checkrun", autolinkid: "autolink",
  };
  if (map[n]) return map[n]!;
  if (n.endsWith("id") && n.length > 2) return n.slice(0, -2);
  if (/(_number|number)$/.test(n)) return n.replace(/_?number$/, "");
  return null;
}
 
function looksLikeHandle(name: string, schema: ParamSchema): boolean {
  if (paramConcept(name, schema)) return true;
  const desc = (schema.description || "").toLowerCase();
  if (
    /\b(identifier|opaque|hexadecimal|alphanumeric string|uuid|generated by|returned by|obtained from)\b/.test(
      desc,
    )
  ) {
    return true;
  }
  return false;
}
 
function extractToolMentions(
  description: string,
  knownSlugs: Set<string>,
  aliases: Map<string, string>,
): string[] {
  if (!description) return [];
  const tokens = description.match(/\b[A-Z][A-Z0-9_]{4,}\b/g) || [];
  const hits = new Set<string>();
  for (const tok of tokens) {
    if (!tok.includes("_")) continue;
    if (knownSlugs.has(tok)) {
      hits.add(tok);
      continue;
    }
    const aliased = aliases.get(tok);
    if (aliased) hits.add(aliased);
  }
  return [...hits];
}
 
// ---------------------------------------------------------------------------
// Producer index
// ---------------------------------------------------------------------------
 
function primaryProducedConcepts(tool: RawTool): Set<string> {
  const out = new Set<string>();
  if (!isReadOnly(tool) || tool.isDeprecated) return out;
 
  const slug = tool.slug.replace(/^(GOOGLESUPER|GITHUB)_/, "");
  const m = slug.match(
    /^(LIST|SEARCH|FIND|FETCH|GET|RETRIEVE|EXPORT|DOWNLOAD)_(.+)$/,
  );
  if (!m) return out;
 
  let nounPhrase = m[2]!;
  // \b in JS doesn't separate _ from letter, so we anchor explicitly.
  const stopMatch = nounPhrase.match(
    /^(.+?)_(?:FOR|IN|BY|FROM|OF|WITH|TO|ON|AS|AT|UNDER)(?:_|$)/,
  );
  if (stopMatch) nounPhrase = stopMatch[1]!;
 
  const tokens = nounPhrase.toLowerCase().split("_").filter(Boolean);
  const filler = new Set([
    "a", "an", "the", "all", "my", "user", "users", "authenticated",
  ]);
  const phraseTokens = tokens.filter((t) => !filler.has(t));
  const phrase = phraseTokens.join("");
 
  const phraseToConcept: Record<string, string> = {
    pullrequests: "pull", pullrequest: "pull",
    issues: "issue", issue: "issue", subissues: "issue",
    repositories: "repo", repository: "repo", repos: "repo", repo: "repo",
    threads: "thread", thread: "thread",
    messages: "message", message: "message", emails: "message", email: "message",
    files: "file", file: "file",
    folders: "folder", folder: "folder",
    comments: "comment", comment: "comment", reviewcomments: "comment",
    labels: "label", label: "label",
    events: "event", event: "event",
    calendars: "calendar", calendar: "calendar", calendarlist: "calendar",
    spreadsheets: "spreadsheet", spreadsheet: "spreadsheet",
    documents: "document", document: "document",
    presentations: "presentation",
    albums: "album", album: "album",
    mediaitems: "mediaitem",
    contacts: "contact", people: "contact",
    tasks: "task", task: "task",
    branches: "branch", branch: "branch",
    tags: "tag", tag: "tag",
    commits: "commit", commit: "commit",
    refs: "ref", ref: "ref",
    releases: "release", release: "release",
    workflows: "workflow", workflow: "workflow",
    workflowruns: "workflowrun", runs: "workflowrun",
    jobs: "job", job: "job",
    artifacts: "artifact", artifact: "artifact",
    teams: "team", team: "team",
    organizations: "org", organization: "org", orgs: "org",
    members: "user", users: "user", user: "user",
    secrets: "secret", secret: "secret",
    environments: "environment",
    gists: "gist", gist: "gist",
    deployments: "deployment",
    discussions: "discussion",
    rulesets: "ruleset",
    checkruns: "checkrun", checksuites: "checksuite",
    hooks: "hook",
    installations: "installation",
  };
 
  if (phraseToConcept[phrase]) {
    out.add(phraseToConcept[phrase]!);
  } else {
    const lastTok = phraseTokens[phraseTokens.length - 1];
    if (lastTok && phraseToConcept[lastTok]) out.add(phraseToConcept[lastTok]!);
    else {
      const single = lastTok ? lastTok.replace(/s$/, "") : "";
      if (single && phraseToConcept[single]) out.add(phraseToConcept[single]!);
    }
  }
  return out;
}
 
function producerScore(slug: string): number {
  const s = slug.toUpperCase();
  let score = 0;
  if (/^(GOOGLESUPER|GITHUB)_LIST_/.test(s)) score += 100;
  else if (/_LIST_/.test(s) || /_LIST$/.test(s)) score += 80;
  if (
    /^(GOOGLESUPER|GITHUB)_SEARCH_/.test(s) ||
    /^(GOOGLESUPER|GITHUB)_FIND_/.test(s)
  )
    score += 90;
  if (/^(GOOGLESUPER|GITHUB)_FETCH_/.test(s)) score += 70;
  if (/^(GOOGLESUPER|GITHUB)_GET_/.test(s)) score += 30;
  score -= Math.max(0, slug.length - 35);
  return score;
}
 
function buildProducerIndex(
  tools: RawTool[],
): Map<string, Map<string, string[]>> {
  const TOP_N = 4;
  const index = new Map<
    string,
    Map<string, { slug: string; score: number }[]>
  >();
 
  for (const t of tools) {
    const concepts = primaryProducedConcepts(t);
    for (const c of concepts) {
      if (!index.has(c)) index.set(c, new Map());
      const byToolkit = index.get(c)!;
      const tk = t.toolkit.slug;
      if (!byToolkit.has(tk)) byToolkit.set(tk, []);
      byToolkit.get(tk)!.push({ slug: t.slug, score: producerScore(t.slug) });
    }
  }
 
  const out = new Map<string, Map<string, string[]>>();
  for (const [c, byToolkit] of index) {
    const ranked = new Map<string, string[]>();
    for (const [tk, list] of byToolkit) {
      list.sort((a, b) => b.score - a.score);
      ranked.set(tk, list.slice(0, TOP_N).map((x) => x.slug));
    }
    out.set(c, ranked);
  }
  return out;
}
 
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
 
async function main() {
  console.log("📥  Loading raw tool catalogs...");
  const google = JSON.parse(
    await readFile("googlesuper_tools.json", "utf-8"),
  ) as RawTool[];
  const github = JSON.parse(
    await readFile("github_tools.json", "utf-8"),
  ) as RawTool[];
  const tools = [...google, ...github].filter((t) => !t.isDeprecated);
  console.log(
    `   ${google.length} googlesuper + ${github.length} github = ${tools.length} active tools`,
  );
 
  const slugs = new Set(tools.map((t) => t.slug));
  const aliases = new Map<string, string>();
  for (const slug of slugs) {
    const woPrefix = slug.replace(/^(GOOGLESUPER|GITHUB)_/, "");
    if (woPrefix !== slug && !slugs.has(woPrefix)) aliases.set(woPrefix, slug);
    for (const altPrefix of [
      "GMAIL", "GOOGLEDRIVE", "GOOGLECALENDAR", "GOOGLEDOCS",
      "GOOGLESHEETS", "GOOGLEMEET", "GOOGLECONTACTS", "GOOGLEPHOTOS",
      "GOOGLETASKS", "GOOGLESLIDES",
    ]) {
      const alt = `${altPrefix}_${woPrefix}`;
      if (!slugs.has(alt)) aliases.set(alt, slug);
    }
  }
 
  console.log("🔍  Building producer index (verb-object structure)...");
  const producers = buildProducerIndex(tools);
  console.log(`   ${producers.size} resource concepts indexed`);
 
  console.log("⚙️   Classifying parameters...");
  const profiles: Record<string, Record<string, DependencyProfile>> = {};
  const edges: GraphEdge[] = [];
  const stats = {
    paramsTotal: 0,
    paramsExplicitDep: 0,
    paramsHeuristicDep: 0,
    paramsUser: 0,
    paramsStatic: 0,
  };
 
  for (const tool of tools) {
    const props = tool.inputParameters?.properties || {};
    const required = new Set(tool.inputParameters?.required || []);
    const profile: Record<string, DependencyProfile> = {};
 
    for (const [pname, pdef] of Object.entries(props)) {
      stats.paramsTotal++;
      const desc = pdef.description || "";
 
      // Signal 1 — explicit mentions in description (highest confidence)
      const explicit = extractToolMentions(desc, slugs, aliases).filter(
        (s) => s !== tool.slug,
      );
      if (explicit.length > 0) {
        profile[pname] = {
          source: "tool",
          required: required.has(pname),
          satisfied_by: explicit,
          confidence: "explicit",
          signal:
            "Producer tool(s) named in parameter description (Composio annotation)",
          description: desc.slice(0, 240),
        };
        for (const producer of explicit) {
          edges.push({
            from: producer, to: tool.slug, param: pname,
            confidence: "explicit", signal: "explicit-mention",
          });
        }
        stats.paramsExplicitDep++;
        continue;
      }
 
      // Signal 2 — concept matching, same toolkit only
      if (looksLikeHandle(pname, pdef)) {
        const concept = paramConcept(pname, pdef);
        const byToolkit = concept ? producers.get(concept) : null;
        const candidates = byToolkit
          ? byToolkit.get(tool.toolkit.slug) || []
          : [];
        const filtered = candidates.filter((s) => s !== tool.slug);
 
        if (filtered.length > 0) {
          profile[pname] = {
            source: "tool",
            required: required.has(pname),
            satisfied_by: filtered,
            confidence: "heuristic",
            signal: `Param looks like a "${concept}" handle; matched producers by concept (same toolkit, top 4 ranked)`,
            description: desc.slice(0, 240),
          };
          for (const producer of filtered) {
            edges.push({
              from: producer, to: tool.slug, param: pname,
              confidence: "heuristic", signal: `concept:${concept}`,
            });
          }
          stats.paramsHeuristicDep++;
          continue;
        }
 
        // Looks like a handle but no producer found — flag low-confidence so
        // the agent runtime asks the user explicitly.
        profile[pname] = {
          source: "tool",
          required: required.has(pname),
          satisfied_by: [],
          confidence: "low",
          signal: "Param looks like an opaque handle but no producer found",
          description: desc.slice(0, 240),
        };
        stats.paramsHeuristicDep++;
        continue;
      }
 
      // Signal 3 — enums / has-default → static
      if (pdef.enum || pdef.default !== undefined) {
        profile[pname] = {
          source: "static",
          required: required.has(pname),
          satisfied_by: [],
          confidence: "heuristic",
          signal: pdef.enum
            ? `Enum (${(pdef.enum as unknown[]).length} options)`
            : "Has default value",
          description: desc.slice(0, 240),
        };
        stats.paramsStatic++;
        continue;
      }
 
      // Default — free-form user input
      profile[pname] = {
        source: "user",
        required: required.has(pname),
        satisfied_by: [],
        confidence: "heuristic",
        signal: "Free-form input — no handle pattern detected",
        description: desc.slice(0, 240),
      };
      stats.paramsUser++;
    }
 
    profiles[tool.slug] = profile;
  }
 
  const nodes: GraphNode[] = tools.map((t) => ({
    slug: t.slug,
    name: t.name,
    toolkit: t.toolkit.slug,
    group: inferGroup(t.slug),
    description: t.description,
    isReadOnly: isReadOnly(t),
  }));
 
  const edgeKey = (e: GraphEdge) => `${e.from}→${e.to}:${e.param}`;
  const edgeMap = new Map<string, GraphEdge>();
  for (const e of edges) {
    const existing = edgeMap.get(edgeKey(e));
    if (
      !existing ||
      (existing.confidence !== "explicit" && e.confidence === "explicit")
    ) {
      edgeMap.set(edgeKey(e), e);
    }
  }
  const dedupedEdges = [...edgeMap.values()];
 
  const graph = {
    meta: {
      generatedAt: new Date().toISOString(),
      toolkits: ["googlesuper", "github"],
      counts: {
        nodes: nodes.length,
        edges: dedupedEdges.length,
        explicitEdges: dedupedEdges.filter((e) => e.confidence === "explicit").length,
        heuristicEdges: dedupedEdges.filter((e) => e.confidence === "heuristic").length,
      },
      stats,
    },
    nodes,
    edges: dedupedEdges,
    tools: profiles,
  };
 
  await writeFile("graph.json", JSON.stringify(graph, null, 2), "utf-8");
 
  console.log("\n✅  graph.json written");
  console.log(`   nodes:           ${nodes.length}`);
  console.log(`   edges (total):   ${dedupedEdges.length}`);
  console.log(`   edges (explicit):  ${graph.meta.counts.explicitEdges}  (Composio-authored)`);
  console.log(`   edges (heuristic): ${graph.meta.counts.heuristicEdges}  (concept-matched)`);
  console.log("\n   parameter classification:");
  console.log(`     user-supplied:   ${stats.paramsUser}  (${pct(stats.paramsUser, stats.paramsTotal)})`);
  console.log(`     tool-producible: ${stats.paramsExplicitDep + stats.paramsHeuristicDep}  (${pct(stats.paramsExplicitDep + stats.paramsHeuristicDep, stats.paramsTotal)})  [${stats.paramsExplicitDep} explicit + ${stats.paramsHeuristicDep} heuristic]`);
  console.log(`     static/enum:     ${stats.paramsStatic}  (${pct(stats.paramsStatic, stats.paramsTotal)})`);
  console.log(`     total params:    ${stats.paramsTotal}`);
}
 
function pct(n: number, d: number): string {
  return d ? ((100 * n) / d).toFixed(1) + "%" : "0%";
}
 
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
 
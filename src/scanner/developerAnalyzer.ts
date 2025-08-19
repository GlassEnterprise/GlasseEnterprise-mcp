import { createHash } from "crypto";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { DeveloperEntity, CommitEntity, TeamEntity } from "./types.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("DeveloperAnalyzer");

interface GitCommitInfo {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  message: string;
  additions: number;
  deletions: number;
  filesChanged: string[];
}

interface DeveloperStats {
  totalCommits: number;
  firstCommit: string;
  lastCommit: string;
  languages: Map<string, number>; // language -> commit count
  filesModified: Set<string>;
}

/**
 * Create a stable ID for a developer based on their normalized name
 */
function createDeveloperId(name: string, repoRoot: string): string {
  const normalizedName = normalizeName(name);
  return createHash("md5")
    .update(`Developer|${normalizedName}|${repoRoot}`)
    .digest("hex");
}

/**
 * Create a stable ID for a commit
 */
function createCommitId(hash: string, repoRoot: string): string {
  return createHash("md5").update(`Commit|${hash}|${repoRoot}`).digest("hex");
}

/**
 * Normalize developer names by removing common inconsistencies
 */
function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ") // Multiple spaces -> single space
    .replace(/[^\w\s\-\.]/g, "") // Remove special chars except hyphen and dot
    .toLowerCase();
}

/**
 * Extract language from file extension
 */
function getLanguageFromFile(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    java: "java",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    go: "go",
    rs: "rust",
    php: "php",
    rb: "ruby",
    kt: "kotlin",
    swift: "swift",
    scala: "scala",
    sh: "shell",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
  };

  return ext ? languageMap[ext] || "other" : "other";
}

/**
 * Execute git command safely
 */
function executeGitCommand(command: string, cwd: string): string {
  try {
    return execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"], // Ignore stderr to prevent noise
      timeout: 30000, // 30 second timeout
    })
      .toString()
      .trim();
  } catch (error) {
    logger.warn(`Git command failed: ${command}`, {
      error: (error as Error).message,
    });
    return "";
  }
}

/**
 * Check if directory is a git repository
 */
function isGitRepository(repoPath: string): boolean {
  try {
    const result = executeGitCommand("git rev-parse --git-dir", repoPath);
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract commit history from git repository
 */
export function extractCommitHistory(
  repoPath: string,
  maxCommits: number = 1000
): GitCommitInfo[] {
  if (!isGitRepository(repoPath)) {
    logger.warn(`Directory is not a git repository: ${repoPath}`);
    return [];
  }

  const commits: GitCommitInfo[] = [];

  try {
    // Get commit information with custom format
    const gitLogCmd = `git log -${maxCommits} --pretty=format:"%H|%h|%an|%ae|%ai|%s" --numstat`;
    const output = executeGitCommand(gitLogCmd, repoPath);

    if (!output) {
      logger.warn(`No git history found in: ${repoPath}`);
      return [];
    }

    const lines = output.split("\n");
    let currentCommit: Partial<GitCommitInfo> | null = null;

    for (const line of lines) {
      if (line.includes("|") && line.length > 40) {
        // This is a commit header line
        if (currentCommit) {
          // Save previous commit
          commits.push(currentCommit as GitCommitInfo);
        }

        const parts = line.split("|");
        if (parts.length >= 6) {
          currentCommit = {
            hash: parts[0],
            shortHash: parts[1],
            authorName: parts[2],
            authorEmail: parts[3],
            timestamp: new Date(parts[4]).toISOString(),
            message: parts.slice(5).join("|"), // In case message contains |
            additions: 0,
            deletions: 0,
            filesChanged: [],
          };
        }
      } else if (line.trim() && currentCommit) {
        // This is a file change line (additions/deletions/filename)
        const parts = line.trim().split("\t");
        if (parts.length >= 3) {
          const additions = parseInt(parts[0]) || 0;
          const deletions = parseInt(parts[1]) || 0;
          const filename = parts[2];

          currentCommit.additions = (currentCommit.additions || 0) + additions;
          currentCommit.deletions = (currentCommit.deletions || 0) + deletions;
          currentCommit.filesChanged = currentCommit.filesChanged || [];
          currentCommit.filesChanged.push(filename);
        }
      }
    }

    // Don't forget the last commit
    if (currentCommit) {
      commits.push(currentCommit as GitCommitInfo);
    }

    logger.info(`Extracted ${commits.length} commits from ${repoPath}`);
    return commits;
  } catch (error) {
    logger.error(`Failed to extract git history from ${repoPath}`, {
      error: (error as Error).message,
    });
    return [];
  }
}

/**
 * Resolve developer identity by consolidating emails and names
 */
function resolveDeveloperIdentity(commits: GitCommitInfo[]): Map<
  string,
  {
    primaryEmail: string;
    names: Set<string>;
    emails: Set<string>;
  }
> {
  const identityMap = new Map<
    string,
    {
      primaryEmail: string;
      names: Set<string>;
      emails: Set<string>;
    }
  >();

  // Group commits by normalized name to find potential matches
  const nameGroups = new Map<string, GitCommitInfo[]>();

  for (const commit of commits) {
    const normalizedName = normalizeName(commit.authorName);
    if (!nameGroups.has(normalizedName)) {
      nameGroups.set(normalizedName, []);
    }
    nameGroups.get(normalizedName)!.push(commit);
  }

  // For each name group, determine primary email and collect aliases
  for (const [normalizedName, groupCommits] of nameGroups) {
    const emailCounts = new Map<string, number>();
    const names = new Set<string>();

    // Count email frequency and collect name variations
    for (const commit of groupCommits) {
      const normalizedEmail = commit.authorEmail.toLowerCase().trim();
      emailCounts.set(
        normalizedEmail,
        (emailCounts.get(normalizedEmail) || 0) + 1
      );
      names.add(commit.authorName);
    }

    // Primary email is the most frequently used one
    const primaryEmail = Array.from(emailCounts.entries()).sort(
      (a, b) => b[1] - a[1]
    )[0][0];

    identityMap.set(normalizedName, {
      primaryEmail,
      names,
      emails: new Set(emailCounts.keys()),
    });
  }

  return identityMap;
}

/**
 * Calculate developer statistics from commits
 */
function calculateDeveloperStats(commits: GitCommitInfo[]): DeveloperStats {
  const languages = new Map<string, number>();
  const filesModified = new Set<string>();

  // Sort commits by timestamp to get first/last
  const sortedCommits = commits.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const commit of commits) {
    // Track languages based on file extensions
    for (const file of commit.filesChanged) {
      const language = getLanguageFromFile(file);
      languages.set(language, (languages.get(language) || 0) + 1);
      filesModified.add(file);
    }
  }

  return {
    totalCommits: commits.length,
    firstCommit: sortedCommits[0]?.timestamp || new Date().toISOString(),
    lastCommit:
      sortedCommits[sortedCommits.length - 1]?.timestamp ||
      new Date().toISOString(),
    languages,
    filesModified,
  };
}

/**
 * Extract developer entities from git history
 */
export function extractDevelopersFromGit(repoPath: string): {
  developers: DeveloperEntity[];
  commits: CommitEntity[];
} {
  const commits = extractCommitHistory(repoPath);
  if (commits.length === 0) {
    return { developers: [], commits: [] };
  }

  // Resolve developer identities
  const identities = resolveDeveloperIdentity(commits);
  const developers: DeveloperEntity[] = [];
  const commitEntities: CommitEntity[] = [];

  // Create developer entities
  for (const [normalizedName, identity] of identities) {
    const developerCommits = commits.filter(
      (c) => normalizeName(c.authorName) === normalizedName
    );

    const stats = calculateDeveloperStats(developerCommits);

    // Get top languages (top 5)
    const primaryLanguages = Array.from(stats.languages.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([lang]) => lang)
      .filter((lang) => lang !== "other");

    // Use the primary name for both id and name to prevent duplicates
    const primaryName = Array.from(identity.names)[0];
    const developer: DeveloperEntity = {
      id: createDeveloperId(primaryName, repoPath),
      type: "Developer",
      name: primaryName,
      email: identity.primaryEmail,
      repoRoot: repoPath,
      aliases: Array.from(identity.emails).filter(
        (e) => e !== identity.primaryEmail
      ),
      primaryLanguages,
      totalCommits: stats.totalCommits,
      firstCommit: stats.firstCommit,
      lastCommit: stats.lastCommit,
    };

    developers.push(developer);
  }

  // Create commit entities
  for (const commit of commits) {
    const normalizedName = normalizeName(commit.authorName);
    const identity = identities.get(normalizedName);

    if (identity) {
      const commitEntity: CommitEntity = {
        id: createCommitId(commit.hash, repoPath),
        type: "Commit",
        name: commit.message.split("\n")[0], // First line as name
        hash: commit.hash,
        shortHash: commit.shortHash,
        message: commit.message,
        author: commit.authorName,
        authorEmail: commit.authorEmail,
        timestamp: commit.timestamp,
        additions: commit.additions,
        deletions: commit.deletions,
        filesChanged: commit.filesChanged,
        repoRoot: repoPath,
      };

      commitEntities.push(commitEntity);
    }
  }

  logger.info(
    `Extracted ${developers.length} developers and ${commitEntities.length} commits from ${repoPath}`
  );
  return { developers, commits: commitEntities };
}

/**
 * Extract team information from CODEOWNERS file
 */
export function extractTeamFromCodeowners(repoPath: string): TeamEntity[] {
  const teams: TeamEntity[] = [];

  // Check multiple possible CODEOWNERS paths in order of preference
  const codeownersPaths = [
    join(repoPath, ".github", "CODEOWNERS"),
    join(repoPath, "docs", "CODEOWNERS"),
    join(repoPath, "CODEOWNERS"),
  ];

  let codeownersFile = "";
  for (const path of codeownersPaths) {
    if (existsSync(path)) {
      codeownersFile = path;
      break;
    }
  }

  if (!codeownersFile) {
    return teams;
  }

  try {
    const content = readFileSync(codeownersFile, "utf8");
    const lines = content.split("\n");
    const teamCounts = new Map<string, number>();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Look for team patterns like @org/team-name with robust regex
      const teamMatches = trimmed.match(
        /@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g
      );
      if (teamMatches) {
        for (const match of teamMatches) {
          const teamName = match.split("/")[1];
          if (teamName) {
            teamCounts.set(teamName, (teamCounts.get(teamName) || 0) + 1);
          }
        }
      }
    }

    // Select the most frequently mentioned team (single team requirement)
    if (teamCounts.size > 0) {
      const sortedTeams = Array.from(teamCounts.entries()).sort((a, b) => {
        // First sort by count (descending), then by name (ascending) for deterministic tie-breaking
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });

      const [selectedTeam, count] = sortedTeams[0];

      // Log warning if multiple teams were found
      if (teamCounts.size > 1) {
        const allTeams = Array.from(teamCounts.keys()).join(", ");
        logger.warn(
          `Multiple teams found in CODEOWNERS, selected "${selectedTeam}" (mentioned ${count} times). All teams: ${allTeams}`,
          {
            repoPath,
            selectedTeam,
            allTeams: Array.from(teamCounts.entries()),
          }
        );
      }

      const team: TeamEntity = {
        id: createHash("md5")
          .update(`Team|${selectedTeam}|${repoPath}`)
          .digest("hex"),
        type: "Team",
        name: selectedTeam,
        repoRoot: repoPath,
        description: `Team extracted from CODEOWNERS (mentioned ${count} times)`,
      };
      teams.push(team);

      logger.info(
        `Extracted team "${selectedTeam}" from CODEOWNERS in ${repoPath}`
      );
    }
  } catch (error) {
    logger.warn(`Failed to read CODEOWNERS file: ${codeownersFile}`, {
      error: (error as Error).message,
    });
  }

  return teams;
}

/**
 * Extract team information from README.md file
 */
export function extractTeamFromReadme(repoPath: string): TeamEntity[] {
  const teams: TeamEntity[] = [];
  const readmeFiles = ["README.md", "README.MD", "readme.md", "Readme.md"];

  let readmeFile = "";
  for (const filename of readmeFiles) {
    const filePath = join(repoPath, filename);
    if (existsSync(filePath)) {
      readmeFile = filePath;
      break;
    }
  }

  if (!readmeFile) {
    return teams;
  }

  try {
    const content = readFileSync(readmeFile, "utf8");
    const lines = content.split("\n");
    const teamCounts = new Map<string, number>();
    const githubTeamCounts = new Map<string, number>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // First priority: Look for GitHub team patterns (@org/team or org/team)
      const githubTeamMatches = line.match(
        /@?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g
      );
      if (githubTeamMatches) {
        for (const match of githubTeamMatches) {
          const teamName = match.split("/")[1];
          if (
            teamName &&
            !teamName.includes("@") &&
            !teamName.includes("http")
          ) {
            githubTeamCounts.set(
              teamName,
              (githubTeamCounts.get(teamName) || 0) + 1
            );
          }
        }
      }

      // Second priority: Look for team patterns in various formats
      const teamPatterns = [
        /^#+\s*team:?\s*(.+)$/i, // # Team: Team Name
        /^team:?\s*(.+)$/i, // Team: Team Name
        /^maintained\s+by:?\s*(.+)$/i, // Maintained by: Team Name
        /^maintainer:?\s*(.+)$/i, // Maintainer: Team Name
        /^owner:?\s*(.+)$/i, // Owner: Team Name
        /^developed\s+by:?\s*(.+)$/i, // Developed by: Team Name
        /^created\s+by:?\s*(.+)$/i, // Created by: Team Name
        /^\*\*team:?\*\*:?\s*(.+)$/i, // **Team**: Team Name
        /^\*\*maintained\s+by:?\*\*:?\s*(.+)$/i, // **Maintained by**: Team Name
      ];

      for (const pattern of teamPatterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          let teamName = match[1]
            .replace(/[*_`]/g, "") // Remove markdown formatting
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Remove markdown links, keep text
            .replace(/[@#]/g, "") // Remove @ and # symbols
            .trim();

          // Skip if it looks like an email or URL
          if (
            !teamName.includes("@") &&
            !teamName.includes("http") &&
            teamName.length > 0
          ) {
            // Extract team name from GitHub team format @org/team
            const githubTeamMatch = teamName.match(/([^\/]+)\/(.+)/);
            if (githubTeamMatch && githubTeamMatch[2]) {
              teamName = githubTeamMatch[2];
              githubTeamCounts.set(
                teamName,
                (githubTeamCounts.get(teamName) || 0) + 1
              );
            } else {
              teamCounts.set(teamName, (teamCounts.get(teamName) || 0) + 1);
            }
          }
        }
      }

      // Third priority: Look for team mentions in project description or about section
      if (
        line.toLowerCase().includes("team") ||
        line.toLowerCase().includes("maintained")
      ) {
        // Check if this line or next few lines contain team information
        const contextLines = lines
          .slice(i, Math.min(i + 3, lines.length))
          .join(" ");
        const teamMentionMatch = contextLines.match(/team\s+(\w+(?:\s+\w+)*)/i);
        if (teamMentionMatch && teamMentionMatch[1]) {
          const potentialTeam = teamMentionMatch[1].trim();
          // Only add if it's not too long and doesn't contain common non-team words
          const skipWords = [
            "name",
            "members",
            "collaboration",
            "development",
            "project",
          ];
          if (
            potentialTeam.length <= 30 &&
            !skipWords.some((word) =>
              potentialTeam.toLowerCase().includes(word)
            )
          ) {
            teamCounts.set(
              potentialTeam,
              (teamCounts.get(potentialTeam) || 0) + 1
            );
          }
        }
      }
    }

    // Select the single best team candidate (prefer GitHub team format)
    let selectedTeam = "";
    let selectedCount = 0;
    let source = "";

    // First check GitHub team mentions (higher priority)
    if (githubTeamCounts.size > 0) {
      const sortedGithubTeams = Array.from(githubTeamCounts.entries()).sort(
        (a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0].localeCompare(b[0]);
        }
      );
      [selectedTeam, selectedCount] = sortedGithubTeams[0];
      source = "GitHub team format";
    } else if (teamCounts.size > 0) {
      // Fallback to regular team mentions
      const sortedTeams = Array.from(teamCounts.entries()).sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });
      [selectedTeam, selectedCount] = sortedTeams[0];
      source = "text patterns";
    }

    if (selectedTeam) {
      // Log info about selection if multiple candidates were found
      const totalCandidates = githubTeamCounts.size + teamCounts.size;
      if (totalCandidates > 1) {
        const allCandidates = [
          ...Array.from(githubTeamCounts.keys()),
          ...Array.from(teamCounts.keys()),
        ].join(", ");
        logger.info(
          `Multiple team candidates found in README, selected "${selectedTeam}" from ${source} (mentioned ${selectedCount} times). All candidates: ${allCandidates}`,
          {
            repoPath,
            selectedTeam,
            source,
            totalCandidates,
          }
        );
      }

      const team: TeamEntity = {
        id: createHash("md5")
          .update(`Team|${selectedTeam}|${repoPath}`)
          .digest("hex"),
        type: "Team",
        name: selectedTeam,
        repoRoot: repoPath,
        description: `Team extracted from README.md via ${source} (mentioned ${selectedCount} times)`,
      };
      teams.push(team);

      logger.info(
        `Extracted team "${selectedTeam}" from README.md in ${repoPath} (fallback used - no CODEOWNERS found)`
      );
    }
  } catch (error) {
    logger.warn(`Failed to read README.md file: ${readmeFile}`, {
      error: (error as Error).message,
    });
  }

  return teams;
}

/**
 * Extract team information from metadata files
 */
export function extractTeamFromMetadata(repoPath: string): TeamEntity[] {
  const teams: TeamEntity[] = [];
  const metadataFiles = [
    "team.json",
    "team.yaml",
    "team.yml",
    ".team.json",
    "package.json", // For maintainers field
  ];

  for (const filename of metadataFiles) {
    const filePath = join(repoPath, filename);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, "utf8");
      let metadata: any;

      if (filename.endsWith(".json")) {
        metadata = JSON.parse(content);
      } else if (filename.endsWith(".yaml") || filename.endsWith(".yml")) {
        // Simple YAML parsing for team name (not a full YAML parser)
        const lines = content.split("\n");
        metadata = {};
        for (const line of lines) {
          const match = line.match(/^\s*(\w+):\s*(.+)$/);
          if (match) {
            metadata[match[1]] = match[2].replace(/['"]/g, "");
          }
        }
      }

      if (metadata) {
        let teamName = "";
        let description = "";

        if (filename === "package.json" && metadata.maintainers) {
          // Extract team from maintainers
          teamName = "maintainers";
          description = `Maintainers: ${metadata.maintainers
            .map((m: any) => m.name || m)
            .join(", ")}`;
        } else if (metadata.team || metadata.name) {
          teamName = metadata.team || metadata.name;
          description = metadata.description || "";
        }

        if (teamName) {
          const team: TeamEntity = {
            id: createHash("md5")
              .update(`Team|${teamName}|${repoPath}`)
              .digest("hex"),
            type: "Team",
            name: teamName,
            repoRoot: repoPath,
            description,
            lead: metadata.lead || metadata.manager,
            size: metadata.size || metadata.members?.length,
          };
          teams.push(team);
        }
      }
    } catch (error) {
      logger.warn(`Failed to parse metadata file: ${filePath}`, {
        error: (error as Error).message,
      });
    }
  }

  return teams;
}

/**
 * Infer team from repository structure and naming conventions
 */
export function inferTeamFromRepoStructure(
  repoPath: string
): TeamEntity | null {
  // Extract potential team name from repository path
  const repoName = repoPath.split(/[\\/]/).pop() || "";
  const teamPatterns = [
    /^(\w+)-/, // team-projectname
    /^(\w+)_/, // team_projectname
    /-(\w+)$/, // projectname-team
    /_(\w+)$/, // projectname_team
  ];

  for (const pattern of teamPatterns) {
    const match = repoName.match(pattern);
    if (match && match[1]) {
      const teamName = match[1];

      // Skip common non-team prefixes
      const skipPrefixes = [
        "api",
        "web",
        "app",
        "service",
        "lib",
        "tool",
        "util",
      ];
      if (skipPrefixes.includes(teamName.toLowerCase())) {
        continue;
      }

      const team: TeamEntity = {
        id: createHash("md5")
          .update(`Team|${teamName}|${repoPath}`)
          .digest("hex"),
        type: "Team",
        name: teamName,
        repoRoot: repoPath,
        description: `Team inferred from repository name: ${repoName}`,
      };

      logger.info(
        `Inferred team "${teamName}" from repository structure: ${repoPath}`
      );
      return team;
    }
  }

  return null;
}

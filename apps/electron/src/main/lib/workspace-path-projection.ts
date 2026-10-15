/** 工作区索引中仅由应用拥有的项目根路径。 */
interface WorkspacePathRecord {
  projectRootPath?: string
}

/** 索引投影所需的最小结构；泛型保留其余字段。 */
interface WorkspacePathIndex {
  workspaces: WorkspacePathRecord[]
}

/** 工作区配置中需要编码的路径字段。 */
interface WorkspacePathConfig {
  attachedDirectories?: string[]
  attachedFiles?: string[]
  worktreeRepos?: Array<{ repoPath: string; worktreesPath: string }>
}

/** 将索引已知路径投影为磁盘引用或运行时绝对路径；不改变输入或未知字段。 */
export function projectWorkspaceIndexPaths<T extends WorkspacePathIndex>(
  index: T,
  mapPath: (path: string) => string,
): T {
  return {
    ...index,
    workspaces: index.workspaces.map((workspace) => ({
      ...workspace,
      ...(typeof workspace.projectRootPath === 'string' ? { projectRootPath: mapPath(workspace.projectRootPath) } : {}),
    })),
  }
}

/** 将配置已知路径投影为磁盘引用或运行时绝对路径；不会替换任意嵌套文本。 */
export function projectWorkspaceConfigPaths<T extends WorkspacePathConfig>(
  config: T,
  mapPath: (path: string) => string,
): T {
  return {
    ...config,
    ...(config.attachedDirectories ? { attachedDirectories: config.attachedDirectories.map(mapPath) } : {}),
    ...(config.attachedFiles ? { attachedFiles: config.attachedFiles.map(mapPath) } : {}),
    ...(config.worktreeRepos ? { worktreeRepos: config.worktreeRepos.map((repo) => ({
      ...repo,
      repoPath: mapPath(repo.repoPath),
      worktreesPath: mapPath(repo.worktreesPath),
    })) } : {}),
  }
}

// 奏折仓是配置不是常量——本仓是公开的，别把私有仓名焊死在代码里。

export interface RepoRef {
  owner: string;
  repo: string;
  slug: string;
}

export const DEFAULT_REVIEW_REPO = 'charliezong18/review';

export function reviewRepo(env: NodeJS.ProcessEnv = process.env): RepoRef {
  const slug = (env.ZHUPI_REVIEW_REPO || DEFAULT_REVIEW_REPO).trim();
  const [owner, repo] = slug.split('/');
  if (!owner || !repo || slug.split('/').length !== 2) {
    throw new Error(`ZHUPI_REVIEW_REPO 得写成 owner/repo，现在是：${slug}`);
  }
  return { owner, repo, slug };
}

# Git that Theo wants

Idea from Theo (https://x.com/theo/status/2069621429189161350 / https://www.youtube.com/watch?v=wEAb0x3wTRc). Note that Theo has no endorsement on this project (yet).

## Rationale - Reinventing Source Code Control (Git)

Theo thinks Git is not the right abstraction for many scenarios. It’s better than all previous source code control systems, so it became the standard. But since Git was invented, a lot has changed, and both Git and GitHub are “rotting from the core.”

### Core pain points

1. **Why can’t you commit a `.env` file?**  
   The superficial answer is: “Because anyone with access to the repository can see sensitive information.” But that’s just “the way Git works” — and that’s not a good reason. It’s a design flaw, not a feature. All those companies that manage secrets (Doppler, Vault, etc.) ultimately just produce a random file on your machine, which is exactly proof that Git has let us down.

2. **Lack of fine-grained permissions**:  
   Why can’t there be private files? Private branches? PRs that stay private until merge? Delayed public release timing? Why are permissions repository-level instead of file-level? Git has none of these concepts at all because it was built for Linux, where these things weren’t necessary for Linux development. But now even Linux needs them — when security vulnerabilities are patched, everyone’s agents are reading the patch and trying to find zero-days before the official announcement. It would be much better if the Linux team could merge security fixes privately, publish the release, and distribute it to distro maintainers before the code becomes public.

3. **Open source does not mean 100% of the code is 100% public**:  
   Many projects would be more willing to open source their code if they could hide unfinished PRs. Many security fixes are delayed because the moment they appear in the tracker, they get exploited. Many projects are forced to split into multiple repositories because they want to open source part of the code, but not all of it.

4. **Commits and branches are not suitable for modern development**:  
   Theo likes what JJ (Jujutsu) does — using snapshots and tags instead of branches and commits. JJ solves many source control ergonomics problems and made Theo realize that we waste too much time on things that don’t matter.

5. **Worktrees are absolutely terrible**:  
   Theo once had an agent’s worktree check out `main`, which caused Theo to be unable to check out `main` in the main directory because it had been “hijacked” by some random worktree.

6. **Source control should not depend on the real operating system and file system**:  
   In a world with Bash (a JavaScript/TypeScript layer that can emulate bash, allowing agents to run without a real Linux kernel or file system), using the CLI to operate Git on real files in a real environment is just stupid. Randomly cloning files in memory is much easier than moving a large number of files around on the system.

### APFS rant

Theo shared a disk performance benchmark: cloning a project + installing with PNPM from cache, using only file creation operations:
-  Ubuntu + mid-range AMD CPU + ordinary SSD: **6.8 seconds**
-  M4 Mac + high-end Apple SSD: **31 seconds**
-  M1 Ultra: **more than 140 seconds**

For the same task, a MacBook running Ubuntu takes only **3–12 seconds**. APFS is complete garbage when handling lots of small files. This makes it extremely painful to spin up lots of small runtimes for agents. Theo believes this is further proof that we should move away from the file system.


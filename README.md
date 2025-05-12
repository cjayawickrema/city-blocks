# City Blocks

City Blocks is a 3D visualization of code churn and size in a Git repo.

![visuals](city-blocks.png)

## Legend
- Grey foundations are parent directories. It darkens progressively as it stacks up.
- Volume of the building or block is relative to the lines of code
- Height is factored with number of git commits on a file, but volume will always be loc cubed.
- Color of the building i.e heat is based on churn % compared to max churn (yellow > amber > red)

## Prerequisites
1. NodeJS - (tested with v20.11.1)
2. Git - (tested with 2.33.1)
3. Decent HW - (Tested with MacBook Air M1)

## How to use (only tested in Mac)

1. run `npm install`
2. run `node index.js`
3. browse `http://localhost:3000`
4. see the demo
5. in order to visualize a different repo, go to project-root directory
6. run `git_repo_stats.sh <<git-clone-url>>`. This updates the data.csv for new repo
7. now refresh browser
8. refine output by excluding unncessary files in `.stat_exclude` file. follow glob pattern
9. If the height is too extreme try adjusting `POWER_CONSTANT_P` by a few decimal points.
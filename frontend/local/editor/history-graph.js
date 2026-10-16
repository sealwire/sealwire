// The branch graph beside the log. Each commit row gets the lanes passing through it and
// the lines to draw in its top half (into the commit) and bottom half (out to parents).
// Lanes never shift sideways once given, so a line is straight until it joins another.

function freeLane(lanes, from = 0) {
  for (let index = from; index < lanes.length; index += 1) {
    if (lanes[index] == null) {
      return index;
    }
  }
  return lanes.length;
}

/**
 * @param {{id: string, parents: string[]}[]} commits newest first, children before parents
 * @returns {{column: number, width: number, top: [number, number][], bottom: [number, number][]}[]}
 *   `top` lines run from a lane at the row's top edge to a lane at its middle; `bottom`
 *   from the middle to the bottom edge. Each pair is `[fromLane, toLane]`.
 */
export function layoutGraph(commits) {
  let lanes = [];
  const rows = [];
  for (const commit of commits) {
    let column = lanes.indexOf(commit.id);
    if (column < 0) {
      column = freeLane(lanes);
    }
    const before = lanes.slice();
    const top = [];
    before.forEach((id, lane) => {
      if (id != null) {
        top.push([lane, id === commit.id ? column : lane]);
      }
    });

    const after = before.map((id) => (id === commit.id ? null : id));
    while (after.length <= column) {
      after.push(null);
    }
    const [first = null, ...rest] = Array.isArray(commit.parents) ? commit.parents : [];
    after[column] = first;
    const targets = first == null ? [] : [column];
    for (const parent of rest) {
      let lane = after.indexOf(parent);
      if (lane < 0) {
        lane = freeLane(after, column + 1);
        after[lane] = parent;
      }
      targets.push(lane);
    }

    const bottom = [];
    after.forEach((id, lane) => {
      if (id != null && before[lane] === id) {
        bottom.push([lane, lane]);
      }
    });
    for (const lane of targets) {
      if (!bottom.some(([from, to]) => from === column && to === lane)) {
        bottom.push([column, lane]);
      }
    }

    while (after.length && after[after.length - 1] == null) {
      after.pop();
    }
    lanes = after;
    rows.push({ column, width: Math.max(before.length, after.length, column + 1), top, bottom });
  }
  return rows;
}

/**
 * Counters and timings for one traversal depth.
 *
 * The split between source time and bookkeeping time is the point of this: a
 * traversal that is slow because a source is slow and one that is slow because
 * it is copying path state look identical from the outside.
 */
export interface IPathDepthStats {
  /** The traversal depth these counters belong to. */
  depth: number;
  /** Distinct nodes submitted to this depth as the frontier. */
  frontierNodes: number;
  /** Partial paths carried into this depth. */
  statesIn: number;
  /** VIA solutions this depth consumed. */
  edges: number;
  /** Partial paths this depth produced, after prefix multiplication. */
  statesOut: number;
  /** Endpoint candidates this depth tested. */
  endpointCandidates: number;
  /** Candidates that matched END. */
  endpointMatches: number;
  /** Paths emitted while this depth ran. */
  emitted: number;
  /** Whether the END constraint travelled with this depth's VIA evaluation. */
  joinedEnd: boolean;
  /** Milliseconds awaiting VIA solutions from a source. */
  sourceMs: number;
  /** Milliseconds awaiting END evaluation. */
  endpointMs: number;
  /** Milliseconds suspended while a consumer took emitted paths. */
  downstreamMs: number;
  /** Milliseconds of synchronous expansion bookkeeping. */
  workMs: number;
  /** Wall-clock milliseconds this depth took, against which the rest divide. */
  depthMs: number;
}

/** Everything measured about one path traversal. */
export interface IPathTraversalStats {
  depths: IPathDepthStats[];
  /** Milliseconds from the start of traversal to the first emitted path. */
  firstPathMs?: number;
  /** Milliseconds from the start of traversal until it stopped, however it stopped. */
  totalMs: number;
}

/**
 * Accumulates traversal counters and timings.
 *
 * Only created when a physical query plan logger is installed, so an ordinary
 * run pays for none of this — the traversal guards every call on the recorder
 * being present.
 */
export class PathTraversalStats {
  private readonly depths: IPathDepthStats[] = [];
  private readonly started = now();
  private firstPathMs: number | undefined;
  private current: IPathDepthStats | undefined;
  private openedAt = 0;

  /** Begin measuring a depth, closing whichever depth was open before it. */
  public openDepth(depth: number, frontierNodes: number, statesIn: number, joinedEnd: boolean): void {
    this.closeDepth();
    this.openedAt = now();
    this.current = {
      depth,
      frontierNodes,
      statesIn,
      edges: 0,
      statesOut: 0,
      endpointCandidates: 0,
      endpointMatches: 0,
      emitted: 0,
      joinedEnd,
      sourceMs: 0,
      endpointMs: 0,
      downstreamMs: 0,
      workMs: 0,
      depthMs: 0,
    };
  }

  public closeDepth(): void {
    if (this.current) {
      this.current.depthMs = now() - this.openedAt;
      this.depths.push(this.current);
      this.current = undefined;
    }
  }

  public count(field: 'edges' | 'statesOut' | 'endpointCandidates' | 'endpointMatches', by = 1): void {
    if (this.current) {
      this.current[field] += by;
    }
  }

  public time(field: 'sourceMs' | 'endpointMs' | 'downstreamMs' | 'workMs', since: number): void {
    if (this.current) {
      this.current[field] += now() - since;
    }
  }

  public recordEmitted(): void {
    this.firstPathMs ??= now() - this.started;
    if (this.current) {
      this.current.emitted++;
    }
  }

  /** The reading to publish, valid at any point during or after a traversal. */
  public read(): IPathTraversalStats {
    return {
      depths: [ ...this.depths, ...this.current ? [ this.current ] : []].map(depth => ({
        ...depth,
        sourceMs: round(depth.sourceMs),
        endpointMs: round(depth.endpointMs),
        downstreamMs: round(depth.downstreamMs),
        workMs: round(depth.workMs),
        depthMs: round(depth.depthMs === 0 ? now() - this.openedAt : depth.depthMs),
      })),
      ...this.firstPathMs === undefined ? {} : { firstPathMs: round(this.firstPathMs) },
      totalMs: round(now() - this.started),
    };
  }
}

/** A monotonic clock, in milliseconds, in both Node and a browser. */
export function now(): number {
  return performance.now();
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

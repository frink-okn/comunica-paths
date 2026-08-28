import { MetadataValidationState } from '@comunica/utils-metadata';
import type * as RDF from '@rdfjs/types';
import { BufferedIterator } from 'asynciterator';
import type { IPathMetadata, PathResult } from './types.js';

/**
 * Tracks the cardinality of a path stream while it is being produced.
 *
 * The estimate is the sum of three parts: the paths already emitted, the
 * traversal states still waiting to be expanded, and — while a depth is being
 * evaluated — the cardinality Comunica itself reported for that expansion. It is
 * refreshed once per completed traversal depth rather than once per path, and
 * becomes exact when the traversal ends. Every refresh invalidates the previous
 * state, following Comunica's metadata invalidation contract.
 */
export class PathMetadata {
  private state = new MetadataValidationState();
  private depth = 0;
  private emitted = 0;
  private pending = Number.POSITIVE_INFINITY;
  private expansion = 0;
  private exact = false;

  /** Invoked after every change, so that a consumer can republish the metadata. */
  public onUpdate: (() => void) | undefined;

  public constructor(private readonly maxPaths: number | undefined) {}

  public read(): IPathMetadata {
    return {
      state: this.state,
      cardinality: {
        type: this.exact ? 'exact' : 'estimate',
        value: this.cardinality(),
      },
      depth: this.depth,
    };
  }

  public recordEmitted(): void {
    this.emitted++;
  }

  /**
   * A traversal depth finished; `pending` is the number of traversal states left
   * to expand. Whatever that depth discovered is now counted exactly, so the
   * estimate that stood in for it is dropped.
   */
  public recordDepth(depth: number, pending: number): void {
    this.depth = depth;
    this.pending = pending;
    this.expansion = 0;
    this.invalidate();
  }

  /**
   * Record the cardinality Comunica reported for a frontier expansion that is
   * still in flight. This is the join actors' own estimate of how much the depth
   * being evaluated will yield, and it stands in for that depth until
   * {@link recordDepth} replaces it with the real count.
   */
  public recordExpansion(cardinality: RDF.QueryResultCardinality): void {
    // A source that cannot count reports a non-finite value — unknown, or an
    // unbounded upper bound. Neither says anything about how many paths are
    // coming, so such an expansion contributes nothing and the projection falls
    // back to the states already known.
    const expansion = Number.isFinite(cardinality.value) ? cardinality.value : 0;
    if (expansion === this.expansion) {
      return;
    }
    this.expansion = expansion;
    this.invalidate();
  }

  public recordCompletion(): void {
    this.exact = true;
    this.invalidate();
  }

  private cardinality(): number {
    if (this.exact) {
      return this.emitted;
    }
    const projected = this.emitted + this.pending + this.expansion;
    return this.maxPaths === undefined ? projected : Math.min(projected, this.maxPaths);
  }

  private invalidate(): void {
    const previous = this.state;
    this.state = new MetadataValidationState();
    this.onUpdate?.();
    previous.invalidate();
  }
}

/**
 * Exposes a path traversal as a standard Comunica iterator.
 *
 * Destroying the iterator tears down the traversal: active bindings streams are
 * destroyed first so that any read waiting on a source unblocks, and the
 * traversal is then wound down through its own cleanup path.
 */
export class PathResultIterator extends BufferedIterator<PathResult> {
  private readonly teardown: (() => void)[] = [];
  private closing = false;

  public constructor(
    private readonly paths: AsyncGenerator<PathResult, void, undefined>,
    private readonly metadata: PathMetadata,
    private readonly abortSources: (cause?: Error) => void,
  ) {
    super({ autoStart: false });
    metadata.onUpdate = (): void => this.setProperty('metadata', metadata.read());
    this.setProperty('metadata', metadata.read());
  }

  /**
   * Register a callback that runs exactly once when this stream is finished, for
   * any reason.
   *
   * `asynciterator` emits `end` only when a stream closes normally: `destroy()`
   * moves straight to the destroyed state, which skips that event and then drops
   * every `end` listener. Cleanup that has to happen on a cancelled stream too
   * therefore cannot be hung off `end`.
   */
  public onDone(callback: () => void): void {
    if (this.done) {
      callback();
      return;
    }
    this.teardown.push(callback);
  }

  protected override _read(count: number, done: () => void): void {
    this.pump(count).then(done, (error: unknown) => {
      // A read that fails because the iterator is already winding down must not
      // start a second teardown.
      if (!this.closing) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
      done();
    });
  }

  protected override _destroy(cause: Error | undefined, callback: (error?: Error) => void): void {
    this.closing = true;
    this.abortSources(cause);
    // End immediately rather than waiting for the traversal to unwind. Its
    // sources have already been destroyed, so cleanup cannot produce anything
    // further, and a cancelled consumer should not keep reading buffered paths
    // while it finishes.
    this.paths.return(undefined).catch(() => {
      // The traversal was cancelled; a failure while unwinding adds nothing.
    });
    callback();
  }

  protected override _end(destroy = false): void {
    super._end(destroy);
    // Reached for both a normal close and a destroy, which is the whole point of
    // running the teardown callbacks from here.
    for (const callback of this.teardown.splice(0)) {
      callback();
    }
  }

  private async pump(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      const next = await this.paths.next();
      if (next.done) {
        this.metadata.recordCompletion();
        this.close();
        return;
      }
      this.metadata.recordEmitted();
      this._push(next.value);
    }
  }
}

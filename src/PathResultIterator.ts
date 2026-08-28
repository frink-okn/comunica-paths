import { MetadataValidationState } from '@comunica/utils-metadata';
import { BufferedIterator } from 'asynciterator';
import type { IPathMetadata, PathResult } from './types.js';

/**
 * Tracks the cardinality of a path stream while it is being produced.
 *
 * The estimate is refreshed once per completed traversal depth rather than once
 * per path, and becomes exact when the traversal ends. Every refresh invalidates
 * the previous state, following Comunica's metadata invalidation contract.
 */
export class PathMetadata {
  private state = new MetadataValidationState();
  private depth = 0;
  private emitted = 0;
  private frontier = Number.POSITIVE_INFINITY;
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

  /** A traversal depth finished; `frontier` is the number of nodes left to expand. */
  public recordDepth(depth: number, frontier: number): void {
    this.depth = depth;
    this.frontier = frontier;
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
    const projected = this.emitted + this.frontier;
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

import { describe, expect, it } from 'vitest';
import { LoadedState } from '../entity-definitions/entity-definition';
import { EntryDraft } from './entry-writer.service';
import { TransactionState } from './transaction-state';

const loaded = (label: string): LoadedState => ({
  values: { name: label },
  groups: new Set(['base']),
  label,
  deleted: false,
});
const draft = (entityId: string): EntryDraft => ({
  entityType: 'Collection',
  entityId,
  entityLabel: entityId,
  action: 'deleted',
  summary: 'deleted',
});

/** A state whose savepoint depth the test moves by hand, like TypeORM's query runner. */
function stateAt(depth = 1, capacity?: number) {
  const runner = { depth };
  const state = new TransactionState(() => runner.depth, capacity);
  const begin = () => {
    runner.depth++;
  };
  const end = (committed: boolean) => {
    runner.depth--;
    state.ended(runner.depth, committed);
  };
  return { state, begin, end };
}

describe('TransactionState', () => {
  it('undoes what a rolled-back savepoint remembered, and keeps what came before it', () => {
    const { state, begin, end } = stateAt();
    state.see('Product:1', loaded('Before'));
    state.remember('Product:1', 10);

    begin();
    state.see('Product:1', loaded('Phantom'));
    state.see('Product:2', loaded('New'));
    state.remember('Product:1', 11);
    state.markCreated('Product:2');
    state.markHead('bulk_edit:a');
    state.deferDeletion('7', draft('7'));
    state.forget('Product:1');
    end(false);

    expect(state.lastSeen.peek('Product:1')?.label).toBe('Before');
    expect(state.lastSeen.has('Product:2')).toBe(false);
    expect(state.entriesByEntity.peek('Product:1')).toBe(10);
    expect(state.createdIds.has('Product:2')).toBe(false);
    expect(state.batchHeads.has('bulk_edit:a')).toBe(false);
    expect(state.collectionDeletions.size).toBe(0);
  });

  it('hands a released savepoint to its parent, whose rollback then undoes both', () => {
    const { state, begin, end } = stateAt();
    begin();
    begin();
    state.remember('Product:1', 11);
    state.markHead('bulk_edit:a');
    end(true);
    expect(state.entriesByEntity.peek('Product:1')).toBe(11);
    expect(state.batchHeads.has('bulk_edit:a')).toBe(true);

    end(false);
    expect(state.entriesByEntity.has('Product:1')).toBe(false);
    expect(state.batchHeads.has('bulk_edit:a')).toBe(false);
  });

  it('puts deferred deletions back when the savepoint that took them rolls back', () => {
    const { state, begin, end } = stateAt();
    state.deferDeletion('7', draft('7'));
    state.deferDeletion('8', draft('8'));

    begin();
    expect([...state.takeDeletions().keys()]).toEqual(['7', '8']);
    expect(state.collectionDeletions.size).toBe(0);
    end(false);

    expect([...state.collectionDeletions.keys()]).toEqual(['7', '8']);
  });

  it('marks a key whose last state the cap evicted', () => {
    const { state } = stateAt(1, 2);
    state.see('Product:1', loaded('1'));
    state.see('Product:2', loaded('2'));
    state.see('Product:3', loaded('3'));

    expect(state.lastSeen.has('Product:1')).toBe(false);
    expect([...state.evicted]).toEqual(['Product:1']);
  });

  it('writes a batch head once per transaction, and a commit of the transaction keeps everything', () => {
    const { state, end } = stateAt();
    state.markHead('bulk_edit:a');
    state.markHead('bulk_edit:a');
    end(true);
    expect([...state.batchHeads]).toEqual(['bulk_edit:a']);
  });
});

export type ClosingState = 'preparee' | 'en_cours' | 'attente_client' | 'bloquee' | 'attente_revue' | 'validee';

const transitions: Record<ClosingState, ClosingState[]> = {
  preparee: ['en_cours', 'bloquee'],
  en_cours: ['attente_client', 'attente_revue', 'bloquee'],
  attente_client: ['en_cours', 'bloquee'],
  bloquee: ['en_cours'],
  attente_revue: ['validee', 'en_cours'],
  validee: [],
};

export class ClosingStateMachine {
  private current: ClosingState;

  constructor(initial: ClosingState) {
    this.current = initial;
  }

  get state(): ClosingState {
    return this.current;
  }

  transition(next: ClosingState): ClosingState {
    if (!transitions[this.current].includes(next)) {
      throw new Error(`Transition ${this.current} -> ${next} interdite`);
    }
    this.current = next;
    return this.current;
  }
}

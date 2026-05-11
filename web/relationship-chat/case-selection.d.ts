export type SelectableCase = {
  id: string;
};

export function shuffleCases<T>(cases: T[], random?: () => number): T[];

export function chooseRandomCaseIndex<T extends SelectableCase>(
  cases: T[],
  options?: {
    playedCaseIds?: Set<string> | string[];
    currentCaseId?: string;
    random?: () => number;
  },
): number;

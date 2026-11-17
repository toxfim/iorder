export interface TabItem {
  readonly id: string;
  readonly label: string;
  /** Muted number after the label (the category tabs show how many products each holds). */
  readonly count?: number;
}

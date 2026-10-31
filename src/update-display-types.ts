export type UpdateRow = {
  package: string;
  status: string;
  version?: string;
  current?: string;
  candidate?: string | null;
  request: string;
  reason?: string;
  error?: string;
};

/**
 * Patient wallet wire shapes (apps/api). Money is decimal-as-string end to end —
 * never parse to a Number for anything but display formatting.
 */

export type WalletTransactionType =
  | 'topup'
  | 'consultation'
  | 'refund'
  | 'reversal'
  | 'adjustment';

export type WalletTransactionStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'reversed';

/** One entry in the wallet ledger (from WalletTransaction::toArray). */
export interface WalletTransactionDto {
  id: string;
  type: WalletTransactionType;
  label: string;
  direction: 'credit' | 'debit';
  amount: string;
  currency: string;
  balance_after: string | null;
  status: WalletTransactionStatus;
  reference: string;
  description: string | null;
  created_at: string;
}

/** The wallet summary (GET /portal/wallet). */
export interface WalletDto {
  currency: string;
  balance: string;
  status: 'active' | 'frozen';
  currencies: string[];
  funding_ready: boolean;
  recent: WalletTransactionDto[];
}

/** Response of POST /portal/wallet/fund — the hosted Paystack checkout. */
export interface FundInitDto {
  authorization_url: string;
  reference: string;
  access_code: string;
}

/** Response of POST /portal/wallet/verify. */
export interface VerifyFundingDto {
  status: string;
  wallet?: { currency: string; balance: string; status: string };
  transaction?: WalletTransactionDto;
}

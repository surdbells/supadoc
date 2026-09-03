import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  FundInitDto,
  PaginatedResponse,
  SuccessResponse,
  VerifyFundingDto,
  WalletDto,
  WalletTransactionDto,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/** Typed client for the signed-in patient's wallet (customer-scoped on the API). */
@Injectable({ providedIn: 'root' })
export class WalletApi {
  private readonly api = inject(ApiService);

  /** GET /api/portal/wallet — balance, currencies and a few recent entries. */
  wallet(currency?: string): Observable<SuccessResponse<WalletDto>> {
    return this.api.get<SuccessResponse<WalletDto>>(
      'api/portal/wallet',
      currency ? ({ currency } as QueryParams) : undefined,
    );
  }

  /** GET /api/portal/wallet/transactions — the ledger, paginated + filterable. */
  transactions(query?: {
    type?: string;
    currency?: string;
    page?: number;
    per_page?: number;
  }): Observable<PaginatedResponse<WalletTransactionDto>> {
    return this.api.get<PaginatedResponse<WalletTransactionDto>>(
      'api/portal/wallet/transactions',
      query as QueryParams | undefined,
    );
  }

  /** POST /api/portal/wallet/fund — start a Paystack top-up; returns checkout URL. */
  fund(
    amount: string,
    currency: string,
  ): Observable<SuccessResponse<FundInitDto>> {
    return this.api.post<SuccessResponse<FundInitDto>>('api/portal/wallet/fund', {
      amount,
      currency,
    });
  }

  /** POST /api/portal/wallet/verify — confirm + settle a top-up after redirect. */
  verify(reference: string): Observable<SuccessResponse<VerifyFundingDto>> {
    return this.api.post<SuccessResponse<VerifyFundingDto>>(
      'api/portal/wallet/verify',
      { reference },
    );
  }
}

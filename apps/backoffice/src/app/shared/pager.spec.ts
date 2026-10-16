import { pageWindow } from './pager';

describe('pageWindow', () => {
  it('shows the first pages, an ellipsis and the last page on page 1', () => {
    expect(pageWindow(1, 12)).toEqual([1, 2, 0, 12]);
  });

  it('shows the current page and its neighbours between two ellipses mid-list', () => {
    expect(pageWindow(6, 12)).toEqual([1, 0, 5, 6, 7, 0, 12]);
  });

  it('shows the first page, an ellipsis and the last pages on the last page', () => {
    expect(pageWindow(12, 12)).toEqual([1, 0, 11, 12]);
  });

  it('shows every page when nothing is hidden', () => {
    expect(pageWindow(3, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
  });

  it('shows a single hidden page as its number, not an ellipsis', () => {
    expect(pageWindow(4, 12)).toEqual([1, 2, 3, 4, 5, 0, 12]);
    expect(pageWindow(9, 12)).toEqual([1, 0, 8, 9, 10, 11, 12]);
  });

  it('keeps the current page within 1…total', () => {
    expect(pageWindow(0, 5)).toEqual([1, 2, 0, 5]);
    expect(pageWindow(9, 5)).toEqual([1, 0, 4, 5]);
    expect(pageWindow(1, 0)).toEqual([1]);
  });
});

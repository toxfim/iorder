import { describe, expect, it, vi } from 'vitest';
import { saveFile, type SaveFileEnv } from './save-file';

describe('saveFile', () => {
  it('clicks a temporary download link with the name, then removes it and frees the blob', () => {
    const deferred: (() => void)[] = [];
    const revokeObjectURL = vi.fn();
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({
        href: this.getAttribute('href') ?? '',
        download: this.download,
        attached: document.body.contains(this),
      });
    });
    const env: SaveFileEnv = {
      document,
      createObjectURL: () => 'blob:https://app.test/1',
      revokeObjectURL,
      defer: (run) => deferred.push(run),
    };

    saveFile(new Blob(['x']), 'iorder-price-v3.xlsx', env);

    expect(clicked).toEqual([
      { href: 'blob:https://app.test/1', download: 'iorder-price-v3.xlsx', attached: true },
    ]);
    expect(document.body.querySelector('a')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    deferred.forEach((run) => run());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://app.test/1');
    click.mockRestore();
  });
});

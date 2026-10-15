/**
 * The back office's modal is the design system's `<sd-dialog>` (native
 * `<dialog>`, top layer, focus handling, bottom sheet on phones). `bo-dialog`
 * stays a selector of that component, so existing templates keep working;
 * write `<sd-dialog>` (DialogComponent from '@supadoc/ui') in new code.
 */
export { DialogComponent as BoDialog } from '@supadoc/ui';

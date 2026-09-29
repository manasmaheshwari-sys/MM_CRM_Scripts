import sys
import time
import pythoncom
import win32com.client as win32

path = r"C:\Users\manas\Downloads\MM_CRM_Scripts\Queue_Flow_Data_Analysis.xlsx"


def with_retry(fn, attempts=5, delay=1.5, label=""):
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            last_err = e
            print(f"  ({label or 'step'} retry {i+1}/{attempts} after error: {e})")
            pythoncom.PumpWaitingMessages()
            time.sleep(delay)
    raise last_err


excel = win32.gencache.EnsureDispatch("Excel.Application")
excel.Visible = False
excel.DisplayAlerts = False
excel.ScreenUpdating = False
try:
    wb = with_retry(lambda: excel.Workbooks.Open(path), label="open")
    time.sleep(1)
    with_retry(lambda: excel.CalculateFullRebuild(), label="calc")
    time.sleep(1)
    with_retry(lambda: wb.Save(), label="save")
    time.sleep(1)

    def scan_errors():
        errors = []
        sheet_count = wb.Worksheets.Count
        for i in range(1, sheet_count + 1):
            ws = wb.Worksheets.Item(i)
            used = ws.UsedRange
            vals = used.Value
            if vals is None:
                continue
            rows = vals if isinstance(vals[0], tuple) else (vals,)
            for r_idx, row in enumerate(rows):
                for c_idx, v in enumerate(row):
                    if isinstance(v, str) and v.startswith("#") and v.endswith(("!", "?", "0")):
                        errors.append((ws.Name, r_idx + 1, c_idx + 1, v))
        return errors

    errors = with_retry(scan_errors, label="scan")

    with_retry(lambda: wb.Close(SaveChanges=False), label="close")
    print(f"Recalculated and saved. Errors found: {len(errors)}")
    for e in errors[:50]:
        print(" ", e)
finally:
    excel.Quit()

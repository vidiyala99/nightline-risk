from app.files import sanitize_filename


def test_strips_path_traversal_and_separators():
    assert sanitize_filename("../../etc/passwd") == "passwd"
    assert sanitize_filename(r"..\\..\\windows\\sys.ini") == "sys.ini"


def test_strips_control_chars_and_quotes_and_leading_dots():
    assert sanitize_filename('lo"ss\r\nrun.csv') == "lossrun.csv"
    assert sanitize_filename("..") == "upload"
    assert sanitize_filename(None) == "upload"

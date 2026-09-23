import sys
import json
import sqlite3
import traceback
import hashlib

def process_html(body):
    try:
        import trafilatura
    except ImportError:
        return {"error": "trafilatura not installed"}
    
    # Extract text with trafilatura
    # Retain title, headings, visible text, tables, and character offsets
    result = trafilatura.extract(body, include_links=True, include_images=False, include_tables=True, output_format='json', with_metadata=True)
    if not result:
        return {"error": "trafilatura extraction failed or returned empty"}
    
    try:
        data = json.loads(result)
        text = data.get('text', '')
        title = data.get('title', '')
    except Exception:
        text = result
        title = ''

    return {"text": text, "title": title}

def process_pdf(body):
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return {"error": "PyMuPDF not installed"}
    
    try:
        doc = fitz.open(stream=body, filetype="pdf")
        text = ""
        for page in doc:
            text += page.get_text() + "\n"
        doc.close()
    except Exception as e:
        return {"error": f"PyMuPDF extraction failed: {e}"}
        
    return {"text": text.strip(), "title": ""}

def main():
    if len(sys.argv) != 3:
        print(json.dumps({"error": "Usage: extract.py <db_path> <evidence_id>"}))
        sys.exit(1)
        
    db_path = sys.argv[1]
    evidence_id = sys.argv[2]
    
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute("SELECT mime_type, body FROM evidence_sources WHERE evidence_id = ?", (evidence_id,))
        row = cursor.fetchone()
        
        if not row:
            print(json.dumps({"error": "Evidence not found"}))
            sys.exit(1)
            
        mime_type = row["mime_type"].lower()
        body = row["body"]
        
        if "pdf" in mime_type:
            result = process_pdf(body)
        elif "html" in mime_type or "text" in mime_type:
            result = process_html(body)
        else:
            result = {"error": f"Unsupported MIME type for extraction: {mime_type}"}
            
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({"error": f"Extraction error: {traceback.format_exc()}"}))
        sys.exit(1)
    finally:
        if 'conn' in locals():
            conn.close()

if __name__ == "__main__":
    main()

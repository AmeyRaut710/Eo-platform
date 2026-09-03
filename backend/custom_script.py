import re

class ScriptValidationError(Exception):
    pass

def validate_and_parse_script(script_text: str):
    if "//VERSION=DRISHTI-1" not in script_text:
        raise ScriptValidationError("Missing //VERSION=DRISHTI-1")
        
    banned = ["window", "document", "fetch", "XMLHttpRequest", "eval", "import", "require", "setTimeout", "setInterval", "=>"]
    for b in banned:
        if b == "=>":
            if "=>" in script_text:
                raise ScriptValidationError(f"Dangerous or unsupported term used: {b}")
        elif re.search(rf'\b{b}\b', script_text):
            raise ScriptValidationError(f"Dangerous or unsupported term used: {b}")
            
    # Extract setup input
    input_match = re.search(r'input:\s*\[(.*?)\]', script_text)
    if not input_match:
        raise ScriptValidationError("Could not parse setup() input array")
        
    bands_str = input_match.group(1).replace('"', '').replace("'", "").replace(" ", "")
    input_bands = [b for b in bands_str.split(',') if b]
    
    if not input_bands:
        raise ScriptValidationError("No input bands specified")
        
    # Extract output bands count
    output_match = re.search(r'output:\s*\{\s*bands:\s*(\d+)\s*\}', script_text)
    output_bands_count = 1
    if output_match:
        output_bands_count = int(output_match.group(1))
        
    # Extract evaluatePixel body
    eval_match = re.search(r'function\s+evaluatePixel\s*\([^)]*\)\s*\{(.*)\}', script_text, re.DOTALL)
    if not eval_match:
        raise ScriptValidationError("Could not find function evaluatePixel(sample)")
        
    body = eval_match.group(1)
    
    # Parse assignments: let varName = expression;
    # This regex handles basic assignments across lines
    assignments = re.findall(r'(?:let|var|const)\s+([a-zA-Z0-9_]+)\s*=\s*(.*?);', body, re.DOTALL)
    variables = {}
    for var_name, expr in assignments:
        variables[var_name] = expr.strip()
        
    # Extract return statement
    return_matches = re.findall(r'return\s*\[(.*?)\];', body, re.DOTALL)
    if not return_matches:
        raise ScriptValidationError("Could not find return statement in evaluatePixel")
        
    returns_str = return_matches[-1]
    returns = [r.strip() for r in returns_str.split(',') if r.strip()]
    
    # Substitute variables in returns
    resolved_returns = []
    for r in returns:
        res = r
        # Substitute multiple times in case of nested variables
        for _ in range(5):
            for v_name, v_expr in variables.items():
                res = re.sub(rf'\b{v_name}\b', f"({v_expr})", res)
        resolved_returns.append(res)
        
    final_expressions = []
    has_datamask = "dataMask" in input_bands
    datamask_idx = input_bands.index("dataMask") + 1 if has_datamask else -1
    
    # List of bands excluding dataMask (these are the ones TiTiler will actually fetch)
    actual_bands = [b for b in input_bands if b != "dataMask"]
    
    for expr in resolved_returns:
        e = expr
        
        # Replace Math functions
        e = e.replace("Math.abs", "abs")
        e = e.replace("Math.sqrt", "sqrt")
        e = e.replace("Math.min", "min")
        e = e.replace("Math.max", "max")
        
        # Map sample.BAND to just BAND
        # This allows the frontend to dynamically replace BAND with the correct STAC asset name
        for band in actual_bands:
            e = re.sub(rf'sample\.{band}\b', band, e)
            
        final_expressions.append(e.replace('\n', '').replace('\r', '').strip())
        
    return {
        "valid": True,
        "bands": actual_bands,
        "expression": ",".join(final_expressions),
        "output_bands": output_bands_count
    }

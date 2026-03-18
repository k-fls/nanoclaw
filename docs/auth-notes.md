1. detect auth errors by the proxy (and refresh if needed) - but we cant retry - this should be indicated to the host
2. oauth request returns a page with status (staus lookup by scope+token) - status is provided by http request to proxy
3. xdg should detect oauth call and report to proxy / also agent should be able to declare oauth domains
4. keys are shuffled but keep structure (letter->letters, digit->digits, punctuation dont change, keep prefix)
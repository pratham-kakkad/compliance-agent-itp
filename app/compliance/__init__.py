"""The Compliance Engine: a generic, configurable way to define a compliance
requirement, decide who it applies to, say what evidence proves it, review that
evidence, and handle non-compliance.

Vocabulary (see README, "Compliance engine"):

- Compliance        the rule (what, by when, what proof, how reviewed, what if ignored)
- Audience rule     who it applies to (person / team / department / role / subtree / all)
- Obligation        one row per person per compliance; status, evidence, review and
                    escalation all hang off this
- Submission        what the person proved (versioned), made of evidence items
- Review decision   approve / reject, with a reason

Nothing here is specific to any one kind of compliance: LinkedIn reposts, policy
acknowledgements, training certificates, document submissions are all the same
machinery with different evidence requirements.
"""

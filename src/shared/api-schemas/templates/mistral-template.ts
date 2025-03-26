export const MISTRAL_TEMPLATE = {
  bosToken: "<s>",
  eosToken: "</s>",
  chatTemplate: `"{%- if messages[0]["role"] == "system" %}
    {%- set system_message = messages[0]["content"] %}
    {%- set loop_messages = messages[1:] %}
{%- else %}
    {%- set loop_messages = messages %}
{%- endif %}
{%- set user_messages = loop_messages | selectattr("role", "equalto", "user") | list %}

{%- for message in loop_messages %}
    {%- if (message["role"] == "user") != (loop.index0 % 2 == 0) %}
        {{- raise_exception("After the optional system message, conversation roles must alternate user/assistant/user/assistant/...") }}
    {%- endif %}
{%- endfor %}

{{- bos_token }}
{%- for message in loop_messages %}
    {%- if message["role"] == "user" %}
        {%- if loop.last and system_message is defined %}
            {{- "[INST] " + system_message + "\\n\\n" + message["content"] + "[/INST]" }}
        {%- else %}
            {{- "[INST] " + message["content"] + "[/INST]" }}
        {%- endif %}
    {%- elif message["role"] == "assistant" %}
        {%- if loop.last and message.prefix is defined and message.prefix %}
            {{- " " + message["content"] }}
        {%- else %}
            {{- " " + message["content"] + eos_token}}
        {%- endif %}
    {%- else %}
        {{- raise_exception("Only user and assistant roles are supported, with the exception of an initial optional system message!") }}
    {%- endif %}
{%- endfor %}`,
};

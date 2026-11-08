/package com.example;

import com.google.common.collect.ImmutableList;
import com.google.common.collect.ImmutableMap;
import com.google.genai.Client;
import com.google.genai.JsonSerializable;
import com.google.genai.gaos.models.interactions.*;
import com.google.genai.gaos.models.operations.*;

public class  {
    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("GEMINI_API_KEY");
        Client client = Client.builder().apiKey(apiKey).build();

        CreateModelInteraction.Builder paramsBuilder =
            CreateModelInteraction.builder()
                .model("models/gemini-3.8-flash");

        paramsBuilder = paramsBuilder.input(InteractionsInput.of("INSERT_INPUT_HERE"));
        paramsBuilder = paramsBuilder.tools(ImmutableList.of(
            GoogleSearch.builder().build()
        ));
        paramsBuilder = paramsBuilder.generationConfig(GenerationConfig.builder()
            .maxOutputTokens(65536)
            .thinkingLevel(ThinkingLevel.of("medium"))
            .build());
        CreateModelInteraction params = paramsBuilder.build();
        CreateInteractionResponse response =
            client.interactions.create(CreateInteractionRequestBody.of(params));

        Interaction interaction = response.interaction().orElseThrow(() -> new RuntimeException("No interaction returned"));
        interaction.steps().ifPresent(steps -> {
            if (!steps.isEmpty()) {
                System.out.println(steps.get(steps.size() - 1));
            }
        });
    }
}


